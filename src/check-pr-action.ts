#!/usr/bin/env node

/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import * as core from '@actions/core';
import * as github from '@actions/github';
import { RestEndpointMethods } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types';
import { RequestInterface } from '@octokit/types';

import { breakingChangeHeader, bugFixChangeHeader, featureChangeHeader, makeChangeEntry } from './changelog';
import {
    BREAKING_CHANGE_LABEL,
    changeFromPrInfo,
    ChangeType,
    getChangeTypeLabels,
    hasChangeTypeLabel,
    labelToChangeType,
    PrInfo,
} from './changes';

const MAGIC_HEAD = '<!-- CHANGELOG_PREVIEW_START -->\n---\n';
const MAGIC_TAIL = '<!-- CHANGELOG_PREVIEW_END -->';
const MAGIC_COMMENT_REGEXP = /<!-- CHANGELOG_PREVIEW_START -->(.|\n)*<!-- CHANGELOG_PREVIEW_END -->/m;

// XXX: The Octokit that getOctokit returns doesn't really look anything like the 'Octokit'
// type. I've given up trying to figure out what's going on with the types in this library
// and rather than waste any more time on it, this is the bits we need.
interface SortOfAnOctokit {
    request: RequestInterface<object>;
    rest: RestEndpointMethods;
}

async function updatePrBody(pr: PrInfo, text: string, octokit: SortOfAnOctokit) {
    const wrappedText = MAGIC_HEAD + text + MAGIC_TAIL;

    let newBody;
    if (pr.body?.match(MAGIC_COMMENT_REGEXP)) {
        newBody = pr.body.replace(MAGIC_COMMENT_REGEXP, wrappedText);
    } else {
        newBody = (pr.body || '') + "\n\n" + wrappedText;
    }

    octokit.rest.issues.update({
        ...github.context.repo,
        issue_number: github.context.payload.number,
        body: newBody,
    });
}

function hasLabel(label: string, pr: PrInfo): boolean {
    return pr.labels.some(l => l.name === label);
}

async function addLabels(octokit: SortOfAnOctokit, pr: PrInfo): Promise<PrInfo> {
    const matches = pr.body?.match(/^Type: ([\w-]+)/im);
    if (matches) {
        let changeType;
        switch (matches[1].toLowerCase()) {
            case 'enhancement':
            case 'feature':
                changeType = ChangeType.FEATURE;
                break;
            case 'defect':
            case 'bugfix':
                changeType = ChangeType.BUGFIX;
                break;
            case 'task':
            case 'internal':
                changeType = ChangeType.TASK;
                break;
            default:
                return;
        }

        for (const [label, labelType] of Object.entries(labelToChangeType)) {
            if (labelType === changeType && !hasLabel(label, pr)) {
                console.log("Adding label: " + label);
                await octokit.rest.issues.addLabels({
                    ...github.context.repo,
                   issue_number: pr.number,
                   labels: [label],
                });
            } else if (labelType !== changeType && hasLabel(label, pr)) {
                console.log("Removing label: " + label);
                await octokit.rest.issues.removeLabel({
                    ...github.context.repo,
                   issue_number: pr.number,
                   name: label,
                });
            }
        }

        console.log("Refreshing PR labels...");
        const resp = await octokit.rest.pulls.get({
            ...github.context.repo,
            pull_number: pr.number,
        });
        // we fix up the current object because the thing this endpoint returns
        // isn't quite the same thing. sigh.
        pr.labels = resp.data.labels;
        //return resp.data;
    }

    return pr;
}

async function main() {
    try {
        console.log("Starting...");
        const myToken = core.getInput('ghToken');
        const octokit = github.getOctokit(myToken);

        // we're assuming the repo name is the same as the project name
        const forProjectName = github.context.repo.repo;
        let pr = github.context.payload.pull_request as PrInfo; // of course the types aren't compatible

        console.log("Scanning for labels to add...");
        pr = await addLabels(octokit, pr);

        const change = changeFromPrInfo(pr);

        const lines = [] as string[];
        if (!hasChangeTypeLabel(pr)) {
            lines.push("This PR currently has no changelog labels, so will not be included in changelogs.");
            lines.push("");
            const labelsWithFormatting = getChangeTypeLabels().map(l => '`' + l + '`').join(", ");
            // This is a very crude approximation of github's permission model.
            // It will almost certainly be wrong sometimes.
            if (['MEMBER', 'OWNER'].includes(change.pr.author_association)) {
                lines.push(
                    `Add one of: ${labelsWithFormatting} to indicate what type of change this is ` +
                    `plus \`${BREAKING_CHANGE_LABEL}\` if it's a breaking change.`,
                );
            } else {
                lines.push(
                    `A reviewer can add one of: ${labelsWithFormatting} to ` +
                    `indicate what type of change this is, or add \`Type: [enhancement/defect/task]\` ` +
                    `to the description and I'll add them for you.`,
                );
            }
        } else if (change.changeType === ChangeType.TASK) {
            lines.push(
                "This change is marked as an *internal change* (Task), so will not be included in the changelog.",
            );
        } else if (change.notes == null) {
            lines.push(
                "This change has no change notes, so will not be included in the changelog.",
            );
        } else {
            const entry = makeChangeEntry(change, { name: forProjectName, ...github.context.repo });

            lines.push("Here's what your changelog entry will look like:");
            lines.push("");
            if (change.breaking) {
                lines.push(breakingChangeHeader);
            } else if (change.changeType === ChangeType.FEATURE) {
                lines.push(featureChangeHeader);
            } else {
                lines.push(bugFixChangeHeader);
            }
            lines.push(entry);
        }

        updatePrBody(pr, lines.join("\n"), octokit);
    } catch (error) {
        console.error(error);
        core.setFailed(error.message);
    }
}

main();
