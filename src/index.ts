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

import log from 'loglevel';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import clc from 'cli-color';
import semver from 'semver';

import {
    ChangeType,
    githubOrgRepoFromDir,
    IChange,
} from "./changes";

import { getLatestRelease, getReleaseBefore, getReleases, releasesContains } from "./releases";
import { ChangesByProject, getPackageJsonAtVersion, Project, branchExists, BranchMode } from './projects';
import { formatIssue } from './issue';
import { previewChangelog, updateChangelog } from './changelog';
import { Octokit } from '@octokit/rest';

function formatChangeType(changeType: ChangeType) {
    switch (changeType) {
        case ChangeType.FEATURE:
            return 'Feature';
        case ChangeType.BUGFIX:
            return 'Bug fix';
        case ChangeType.TASK:
        case null:
            return "Internal change";
    }
}

function printChangeStatus(change: IChange, projectName: string, owner: string, repo: string) {
    console.log(formatChangeType(change.changeType) + ": " + change.pr.html_url);

    console.log(`\t${change.notes === null ? '<no notes>' : change.notes}`);

    for (const [proj, note] of Object.entries(change.notesByProject)) {
        let fmt = (x) => { return x; };
        if (proj === projectName) fmt = clc.bold;
        console.log("\t" + fmt(`${proj} notes: ${note}`));
    }

    if (change.headline) {
        console.log('\t' + clc.bold.inverse(`HEADLINE: ${change.headline}`));
    }

    for (const fixes of change.fixes) {
        console.log("\tFixes " + formatIssue(fixes, owner, repo));
    }

    if (change.changeType === null) {
        console.log(clc.red.bold("\t\u26A0\uFE0F  No type label!"));
    }
    if (change.breaking) {
        console.log("\t\uD83D\uDCA5  Marked as breaking");
    }
}

async function main() {
    const args = yargs(hideBin(process.argv)).version(false).options({
        "debug": {
            alias: 'd',
            type: 'boolean',
            description: "Enable debug mode",
        },
        "check": {
            type: 'boolean',
            description: "Don't update changelog, just output information on what changes would be included",
            conflicts: ["preview"],
        },
        "preview": {
            type: "boolean",
            description: "Generate changelog as normal, but without version header and output to STDOUT.",
            conflicts: ["check"],
        },
    }).command("* [version]", "Generate changelog for the given version", yargs => (
        yargs.positional("version", {
            description: "The version to generate the changelog for, " +
                "required if --check and/or --preview are not specified.",
            type: "string",
        })
    )).help().parseSync();

    if (!args.version && !args.check && !args.preview) {
        // Surely yargs should be able to do this? It seems incredibly confusing and I already regret using it
        console.log("No version specified");
        return;
    }

    if (args.debug) {
        log.setLevel(log.levels.DEBUG);
    }

    const octo = new Octokit({
        auth: process.env.CHANGELOG_GITHUB_TOKEN,
    });

    const dir = process.cwd();
    const projectName = (await getPackageJsonAtVersion(dir, '')).name;
    log.debug("Project: " + projectName);
    const project = await Project.make(projectName, dir);
    const [owner, repo] = await githubOrgRepoFromDir(dir);
    let branchMode = BranchMode.Exact;

    const rels = await getReleases(octo, owner, repo);
    let fromVer: string;
    let toVer: string;

    if (args.version) {
        const targetReleaseSemVer = semver.parse(args.version);
        const targetIsPrerelease = targetReleaseSemVer.prerelease.length > 0;
        const toVerReleaseBranch =
            `release-v${targetReleaseSemVer.major}.${targetReleaseSemVer.minor}.${targetReleaseSemVer.patch}`;
        if (releasesContains(rels, args.version)) {
            log.debug("Found existing release for " + args.version);
            // nb. getReleases only gets the most recent 100 so this won't work
            // for older releases
            fromVer = getReleaseBefore(rels, args.version, targetIsPrerelease).name;
            toVer = args.version;
        } else if (args.version !== 'develop' && await branchExists(dir, toVerReleaseBranch)) {
            log.debug("Found release branch for " + args.version);
            // 'to' release has had a release branch cut but not yet a full release
            // compare to the tip of the release branch
            fromVer = getLatestRelease(rels, targetIsPrerelease).name;
            toVer = toVerReleaseBranch;
            branchMode = BranchMode.Release;
        } else if (args.version !== 'develop' && await branchExists(dir, "staging")) {
            log.debug("Found release branch for " + args.version);
            // 'to' release has had a release branch cut but not yet a full release
            // compare to the tip of the release branch
            fromVer = getLatestRelease(rels, targetIsPrerelease).name;
            toVer = "staging";
            branchMode = BranchMode.Release;
        } else {
            log.debug("Found neither release nor branch for " + args.version);
            // the 'to' release is an doesn't-yet-exist future release -
            // compare to the tip of develop (a better piece of software
            // might make this configurable...)
            fromVer = getLatestRelease(rels, targetIsPrerelease).name;
            toVer = 'develop';
            branchMode = BranchMode.Develop;
        }
    } else {
        fromVer = getLatestRelease(rels, false).name;
        toVer = 'develop';
        branchMode = BranchMode.Develop;
    }

    const changes = {} as ChangesByProject;
    await project.collectChanges(octo, changes, fromVer, toVer, branchMode);
    const allChanges = [].concat(...Object.values(changes)) as IChange[];
    //log.debug(changes);

    if (args.check) {
        console.log(`Will include from home project (${projectName}): `);
        for (const change of changes[projectName].filter(c => c.shouldInclude)) {
            printChangeStatus(change, projectName, owner, repo);
        }
        for (const [subProj, subChanges] of Object.entries(changes)) {
            if (subProj === projectName) continue;

            console.log("\nWill include from " + subProj + ":");
            for (const change of subChanges.filter(c => c.shouldInclude)) {
                printChangeStatus(change, projectName, owner, repo);
            }
        }

        console.log(`\nWill omit from home project (${projectName}): `);
        for (const change of changes[projectName].filter(c => !c.shouldInclude)) {
            printChangeStatus(change, projectName, owner, repo);
        }

        for (const [subProj, subChanges] of Object.entries(changes)) {
            if (subProj === projectName) continue;

            console.log("\nWill omit from " + subProj + ":");
            for (const change of subChanges.filter(c => !c.shouldInclude)) {
                printChangeStatus(change, projectName, owner, repo);
            }
        }

        const numBreaking = allChanges.filter(c => c.breaking).length;
        const numFeatures = allChanges.filter(c => c.changeType == ChangeType.FEATURE).length;
        let suggestedBumpType: "major" | "minor" | "patch";
        if (numBreaking) {
            suggestedBumpType = 'major';
        } else if (numFeatures) {
            suggestedBumpType = 'minor';
        } else {
            suggestedBumpType = 'patch';
        }
        const suggestedVersion = semver.inc(fromVer, suggestedBumpType);
        console.log('');
        console.log(`${clc.bold(numBreaking)} breaking changes and ${clc.bold(numFeatures)} features.`);
        console.log(`According to semver, this would be a ${clc.bold(suggestedBumpType)} release.`);
        console.log(`Suggested version number: ${clc.bold(suggestedVersion)}`);
        return;
    }

    if (args.preview) {
        await previewChangelog(project, allChanges);
        return;
    }

    log.debug("Updating changelog entry for " + args.version);
    await updateChangelog(project, allChanges, args.version);
}

main();
