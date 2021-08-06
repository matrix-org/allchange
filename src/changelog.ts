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

import { ChangeType, IChange } from "./changes";
import { getChangeNotes, IProject, Project } from "./projects";
import { formatIssue } from "./issue";

import semver, { SemVer } from 'semver';
import fs from 'fs';
import fsProm from 'fs/promises';
import readline from 'readline';
import path from 'path';
import log from 'loglevel';

export interface IChangelogEntry {
    version: string;
    text: string;
}

export const securityFixHeader = '## \uD83D\uDD12 SECURITY FIXES';
export const breakingChangeHeader = '## \uD83D\uDEA8 BREAKING CHANGES';
export const featureChangeHeader = '## \u2728 Features';
export const bugFixChangeHeader = '## \uD83D\uDC1B Bug Fixes';

async function* readChangelog(project: Project): AsyncGenerator<IChangelogEntry> {
    const fp = fs.createReadStream(path.join(project.dir, 'CHANGELOG.md'));
    const rl = readline.createInterface(fp);

    let version;
    let fullText = '';
    for await (const line of rl) {
        const matches = /^Changes in \[([\d.]+)\]/.exec(line);
        if (matches) {
            if (version) {
                yield {
                    version,
                    text: fullText,
                };
            }
            version = 'v' + matches[1];
            fullText = '';
        }
        if (version) fullText += line + "\n";
    }
    if (version) {
        yield {
            version,
            text: fullText,
        };
    }
}

// A really simple markdown sanitiser to prevent entries where someone's
// used a rogue asterisk from making things silly
// Actually github's markdown formatter handles this perfectly sensibly,
// but it does send the vim syntax highlihter into meltdown (although what doesn't?)
// Just check that there's an even number of certain nonescaped chars, and if not,
// escape them
function sanitiseMarkdown(text: string): string {
    const specialChars = {
        '*': 0,
        // shall we do the others? let's just start with this one
    };

    const iterChars = (t: string, fn) => {
        let escape = false;
        for (let i = 0; i < t.length; ++i) {
            fn(t[i], escape);
            escape = t[i] == '\\';
        }
    };

    iterChars(text, (c, escape) => {
        if (!escape && Object.keys(specialChars).includes(c)) {
            ++specialChars[c];
        }
    });

    for (const [special, count] of Object.entries(specialChars)) {
        if (count % 2) {
            let newText = '';
            iterChars(text, (c, escape) => {
                if (c === special && !escape) {
                    newText += '\\' + c;
                } else {
                    newText += c;
                }
            });
            text = newText;
        }
    }

    return text;
}

function engJoin(things): string {
    if (things.length === 1) return things[0];

    const firstLot = things.slice(0, things.length - 2);
    const lastTwo = things.slice(things.length - 2);

    let result = '';
    if (firstLot.length) {
        result = firstLot.join(', ') + ' ';
    }
    result += lastTwo.join(' and ');

    return result;
}

export function makeChangeEntry(change: IChange, forProject: IProject): string {
    let line = '';

    line += ` * ${sanitiseMarkdown(getChangeNotes(change, forProject.name))}`;
    line += ` ([\\#${change.pr.number}](${change.pr.html_url})).`;

    if (change.fixes.length > 0) {
        const fixesString = engJoin(change.fixes.map(c => formatIssue(c, forProject.owner, forProject.repo)));
        line += ` Fixes ${fixesString}.`;
    }

    if (!['MEMBER', 'OWNER'].includes(change.pr.author_association)) {
        line += ` Contributed by [${change.pr.user.login}](${change.pr.user.html_url}).`;
    }

    return line;
}

function makeChangelogEntry(changes: IChange[], version: string, forProject: Project): string {
    const formattedVersion = semver.parse(version).format(); // easy way of removing the leading 'v'
    const now = new Date();

    const lines = [];

    const padTwo = n => String(n).padStart(2, '0');
    lines.push(`Changes in ` +
        `[${formattedVersion}](https://github.com/vector-im/element-desktop/releases/tag/v${formattedVersion}) ` +
        `(${now.getFullYear()}-${padTwo(now.getMonth())}-${padTwo(now.getDate())})`,
    );
    lines.push('='.repeat(lines[0].length));
    lines.push('');

    const shouldInclude = changes.filter(c => c.shouldInclude);
    const breaking = shouldInclude.filter(c => c.breaking);
    const security = shouldInclude.filter(c => c.security);

    const others = shouldInclude.filter(c => !c.breaking && !c.security);
    const features = others.filter(c => c.changeType == ChangeType.FEATURE);
    const bugfixes = others.filter(c => c.changeType == ChangeType.BUGFIX);

    if (security.length > 0) {
        lines.push(securityFixHeader);
        for (const change of security) {
            lines.push(makeChangeEntry(change, forProject));
        }
        lines.push('');
    }

    if (breaking.length > 0) {
        lines.push(breakingChangeHeader);
        for (const change of breaking) {
            lines.push(makeChangeEntry(change, forProject));
        }
        lines.push('');
    }

    if (features.length > 0) {
        lines.push(featureChangeHeader);
        for (const change of features) {
            lines.push(makeChangeEntry(change, forProject));
        }
        lines.push('');
    }

    if (bugfixes.length > 0) {
        lines.push(bugFixChangeHeader);

        for (const change of bugfixes) {
            lines.push(makeChangeEntry(change, forProject));
        }
        lines.push('');
    }

    lines.push('');

    return lines.join("\n");
}

function isPrereleaseFor(version: SemVer, forVersion: SemVer): boolean {
    return (
        version.prerelease.length > 0 &&
        forVersion.prerelease.length == 0 &&
        version.compareMain(forVersion) === 0
    );
}

export async function updateChangelog(project: Project, changes: IChange[], forVersion: string) {
    const forReleaseSemVer = semver.parse(forVersion);

    const changelogFile = path.join(project.dir, 'CHANGELOG.md');
    const tmpFile = path.join(project.dir, 'CHANGELOG.tmp');

    const outHandle = await fsProm.open(tmpFile, 'w');
    let changeWritten = false;

    for await (const entry of readChangelog(project)) {
        if (forReleaseSemVer.compare(entry.version) === 0) {
            log.debug(`Found ${entry.version} which is exactly the version we should be updating`);
            // This is the exact version we should be updating: replace it
            await outHandle.write(makeChangelogEntry(changes, forVersion, project));
            changeWritten = true;
        } else if (forReleaseSemVer.compare(entry.version) === 1) {
            // This one comes before the one we're updating, so if we haven't yet written
            // our changeset, we need to do it now.
            if (!changeWritten) {
                log.debug(`Writing change before older version ${entry.version}`);
                await outHandle.write(makeChangelogEntry(changes, forVersion, project));
                changeWritten = true;
            }
            // and then write the one we found too
            await outHandle.write(entry.text);
        } else if (isPrereleaseFor(semver.parse(entry.version), forReleaseSemVer)) {
            log.debug(`Found ${entry.version} which is a prerelease of the version we should be updating`);
            // This is a prerelease of the version we're trying to write, so remove the
            // prerelease entry from the changelog and replace it with the entry we're
            // writing, if we haven't already written it
            if (!changeWritten) {
                await outHandle.write(makeChangelogEntry(changes, forVersion, project));
            }
        } else {
            log.debug(`Found ${entry.version} which is newer than the version we should be updating`);
            await outHandle.write(entry.text);
        }
    }

    await outHandle.close();

    if (!changeWritten) {
        throw new Error("I failed to write the change... that shouldn't happen");
    }

    await fsProm.unlink(changelogFile);
    await fsProm.rename(tmpFile, changelogFile);
    log.debug(`Wrote to ${changelogFile}`);
}
