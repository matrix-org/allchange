/*
Copyright 2020-2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as childProcess from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { promises as fsProm } from 'fs';
import { Octokit } from '@octokit/rest';
import { Endpoints } from '@octokit/types';
import log from 'loglevel';

const GITHUB_PREFIX = 'https://github.com/';

const NOTES_MAGIC_TEXT = 'notes: ';
const PROJECT_NOTES_REGEX = new RegExp(`^([\\w-]*) ${NOTES_MAGIC_TEXT}(.*)$`, 'i');
const HEADLINE_MAGIC_TEXT = 'headlines: ';

const SQUASH_NUMBER_REGEXP = /\(#(\d+)\)/i; // "Message (#1234)", matching the number
const HASH_NUMBER_ISSUE_REGEXP = /(?:close[sd]?|fix|fixe[sd]|resolve[sd]?):? #(\d+)/i;
const OWNER_HASH_NUMBER_ISSUE_REGEXP = /(?:close[sd]?|fix|fixe[sd]|resolve[sd]?):? ([\w-]*)\/([\w-]*)#(\d+)/i;
const ISSUE_URL_REGEXP =
    /(?:close[sd]?|fix|fixe[sd]|resolve[sd]?):? https?:\/\/github.com\/([\w-]*)\/([\w-]*)\/issues\/([\d]*)/i;

const MERGE_COMMIT_REGEX = /Merge pull request #(\d+) from (.*)/;

export enum ChangeType {
    FEATURE,
    BUGFIX,
    TASK,
    DEPRECATION,
}

export const labelToChangeType = {
    'T-Deprecation': ChangeType.DEPRECATION,
    'T-Enhancement': ChangeType.FEATURE,
    'T-Defect': ChangeType.BUGFIX,
    'T-Task': ChangeType.TASK,
};

export const BREAKING_CHANGE_LABEL = 'X-Breaking-Change';

// M A G I C!: https://stackoverflow.com/questions/41253310/typescript-retrieve-element-type-information-from-array-type#51399781
// (Github gives us the return type of the endpoints, which is an array: we want the type
// of one of its elements)
export type ArrayElement<ArrayType extends readonly unknown[]> =
    ArrayType extends readonly (infer ElementType)[] ? ElementType : never;

export type PrInfo = ArrayElement<Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data']>;

export interface IChange {
    pr: PrInfo;
    notes: string;
    notesByProject: Record<string, string>;
    headline: string;
    changeType: ChangeType;
    fixes: IIssueID[];
    breaking: boolean;
    security: boolean;
    shouldInclude?: boolean;
}

export interface IIssueID {
    owner: string;
    repo: string;
    number: number;
}

export interface MergeCommit {
    PrNumber: number;
    sha: string;
}

export async function githubOrgRepoFromDir(repoDir: string) {
    const pkgJson = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), {
        encoding: 'utf8',
    }));

    if (!pkgJson.repository || pkgJson.repository.type !== 'git') {
        throw new Error(repoDir + " doesn't have a 'git' type repo in package.json!");
    }
    if (!pkgJson.repository.url.startsWith(GITHUB_PREFIX)) {
        throw new Error(repoDir + "'s repository isn't a github https url!'");
    }

    const parts = pkgJson.repository.url.slice(GITHUB_PREFIX.length).split('/');
    if (parts.length !== 2) {
        throw new Error('Malformed github URL in repository URL for ' + repoDir);
    }

    return parts;
}

export function getMergedPrs(repoDir: string, from: string, to: string): Promise<MergeCommit[]> {
    // ew: look for some common branch names and look for the origin versions so we don't
    // rely on the local copy of the branches being pulled
    // better way of doing this? when getting the package.json we just try the 'origin' version first
    const hackRevision = rev => {
        if (rev.startsWith('release') || rev === 'develop') return 'origin/' + rev;
        return rev;
    };

    return new Promise<MergeCommit[]>((resolve) => {
        const proc = childProcess.spawn('git', [
            'rev-list',
            // '--merges', // we have squash merges now, so can't filter
            '--format=medium',
            '^' + hackRevision(from),
            hackRevision(to),
        ], {
            cwd: repoDir,
        });

        const rl = readline.createInterface({
            input: proc.stdout,
        });

        const prs = [] as MergeCommit[];

        let commit;
        rl.on('line', line => {
            const trimmed = line.trim();

            if (trimmed.startsWith('commit ')) {
                commit = trimmed.split(' ')[1];
            }
            const match = trimmed.match(MERGE_COMMIT_REGEX);
            const squashMatch = trimmed.match(SQUASH_NUMBER_REGEXP);
            if (match) {
                prs.push({
                    PrNumber: parseInt(match[1]),
                    sha: commit,
                });
            } else if (squashMatch) {
                prs.push({
                    PrNumber: parseInt(squashMatch[1]),
                    sha: commit,
                });
            }
        });
        rl.on('close', () => {
            resolve(prs);
        });
    });
}

export function getChangeTypeLabels(): string[] {
    return Object.keys(labelToChangeType);
}

export function hasChangeTypeLabel(pr: PrInfo): boolean {
    const changeLabels = getChangeTypeLabels();
    for (const lbl of pr.labels) {
        if (changeLabels.includes(lbl.name)) return true;
    }

    return false;
}

export function changeFromPrInfo(pr: PrInfo): IChange {
    let breaking = false;
    const security = false;
    let changeType: ChangeType = null;
    for (const label of pr.labels) {
        if (labelToChangeType[label.name] !== undefined) {
            changeType = labelToChangeType[label.name];
        } else if (label.name === BREAKING_CHANGE_LABEL) {
            breaking = true;
        }
    }

    // security fixes are annoying: we normally do them with github's security advisory
    // tooling, but this creates a temporary private fork and merges the changes in with a merge
    // commit similar to a PR, but no github pull object ever exists. Best we could do is
    // parse the body of the merge commit to try to work out that it's a security fix.
    /*if () {
        security = true;
    }*/

    let notes = pr.title;
    let headline = null;
    const notesByProject = {};
    let matches: RegExpMatchArray;
    const fixes = [] as IIssueID[];

    if (pr.body) {
        for (const line of pr.body.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith(NOTES_MAGIC_TEXT)) {
                notes = trimmed.split(':', 2)[1].trim();
                if (notes.toLowerCase() === 'none') notes = null;
            } else if (trimmed.toLowerCase().startsWith(HEADLINE_MAGIC_TEXT)) {
                headline = trimmed.split(':', 2)[1].trim();
            } else if (matches = line.match(PROJECT_NOTES_REGEX)) {
                notesByProject[matches[1]] = matches[2].trim();
                if (notesByProject[matches[1]].toLowerCase() === 'none') notesByProject[matches[1]] = null;
            } else if (matches = line.match(HASH_NUMBER_ISSUE_REGEXP)) {
                // bafflingly, github's API doesn't give you issues fixed by this PR,
                // so let's try to parse it ourselves (although of course this will only
                // get ones in the PR body, not the comments...)
                fixes.push({
                    owner: pr.base.repo.owner.name,
                    repo: pr.base.repo.name,
                    number: parseInt(matches[1]),
                });
            } else if (matches = line.match(OWNER_HASH_NUMBER_ISSUE_REGEXP)) {
                fixes.push({
                    owner: matches[1],
                    repo: matches[2],
                    number: parseInt(matches[3]),
                });
            } else if (matches = line.match(ISSUE_URL_REGEXP)) {
                fixes.push({
                    owner: matches[1],
                    repo: matches[2],
                    number: parseInt(matches[3]),
                });
            }
        }
    }

    return {
        pr,
        notes,
        notesByProject,
        headline,
        changeType,
        fixes,
        breaking,
        security,
    };
}

export async function getPrInfo(
    octo: Octokit, repoOwner: string, repoName: string, mergeCommits: MergeCommit[],
): Promise<PrInfo[]> {
    const prMap = new Map<number, string>();
    for (const c of mergeCommits) {
        prMap.set(c.PrNumber, c.sha);
    }
    const mergedPrInfo: PrInfo[] = [];

    // This is how you're supposed to paginate with octokit, but it seems like the types are
    // so screwed that typescript can't resolve them (the below sinppet failed to compile).
    // You're not supposed to use pagination directly because some APIs have sensible pagination
    // APIs with prev/next references. This one doesn't though, so it doesn't really matter.
    /*
    octo.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner: 'matrix-org',
        repo: 'matrix-react-sdk',
        state: 'closed',
        sort: 'created',
        direction: 'desc',
        per_page: 100,
    }, (resp, done: () => void): void => {
        return resp;
    });
    */

    const checkAndAddPrInfo = (prInfo: PrInfo) => {
        const expectedSha = prMap.get(prInfo.number);
        if (prInfo.merge_commit_sha === expectedSha) {
            mergedPrInfo.push(prInfo);
        } else {
            log.debug(
                `Ignoring PR ${prInfo.number} because merge commit ` +
                `(${prInfo.merge_commit_sha}) doesn't match git (${expectedSha})`,
            );
        }
        prMap.delete(prInfo.number);
    };

    let pageNum = 1;
    while (prMap.size > 0) {
        if (prMap.size === 1) {
            const prNum = prMap.keys().next().value;
            log.debug(`Fetching remaining PR ${prNum} individually...`);
            const prResp = await octo.pulls.get({
                owner: repoOwner,
                repo: repoName,
                pull_number: prNum,
            });
            // XXX: The object shapes of items in the 'list pulls' API and what you
            // get from the 'get pull' API are different. Hopefully they're close
            // enough for our purposes...
            checkAndAddPrInfo(prResp.data as unknown as PrInfo);
            break;
        }

        // Github doesn't have a way to get multiple PRs at once, but we can list them
        // all. Since we generally want the most recent, this is probably fine and is a
        // single API call rather than one for each merged PR.
        log.debug(prMap.size + " PRs left to find");
        log.debug("Still have to find: " + Array.from(prMap.keys()).join(', '));
        log.debug("Getting page " + pageNum);
        const prListResp = await octo.rest.pulls.list({
            owner: repoOwner,
            repo: repoName,
            state: 'closed',
            sort: 'updated', // We assume we're looking for the most recently merged ones
            direction: 'desc',
            per_page: 100,
            page: pageNum,
        });
        //console.log("Got PRs: " + prListResp.data.map(pr => pr.number).join(', '));

        if (prListResp.data.length === 0) break;

        for (const pr of prListResp.data) {
            if (prMap.has(pr.number)) {
                checkAndAddPrInfo(pr);
            }
        }

        pageNum++;
    }

    if (prMap.size > 0) {
        log.debug("Found info on prs: " + mergedPrInfo.map(pr => pr.number).join(', '));
        log.debug("Couldn't find: " + Array.from(prMap).join(', '));
        // 100 is the max per page so if we didn't find them all, we'll have to paginate
        throw new Error("Couldn't find all PRs");
    }
    return mergedPrInfo;
}
