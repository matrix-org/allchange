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

import { Octokit } from '@octokit/rest';
import { Endpoints } from '@octokit/types';
import { ArrayElement } from './changes';

type Releases = Endpoints['GET /repos/{owner}/{repo}/releases']['response']['data'];
export type Release = ArrayElement<Releases>;

// nb. this only gets a single pag, so if your're looking for a release
// more than 100 releases ago then, well, bad times.
export async function getReleases(owner: string, repo: string): Promise<Releases> {
    const octo = new Octokit();
    const rels = await octo.rest.repos.listReleases({
        owner, repo, per_page: 100,
    });

    return rels.data;
}

export function releasesContains(rels: Releases, target: string): boolean {
    return rels.some(r => r.name === target);
}

export function getLatestRelease(rels: Releases, considerRCs: boolean): Release {
    if (considerRCs) return rels[0];

    for (const rel of rels) {
        if (!rel.prerelease) return rel;
    }
}

export function getReleaseBefore(rels: Releases, target: string, considerRCs: boolean): Release {
    let found = false;

    for (const rel of rels) {
        if (rel.name === target) {
            found = true;
        } else if (found) {
            if (considerRCs || !rel.prerelease) {
                return rel;
            }
        }
    }

    if (!found) {
        throw new Error("Couldn't find release " + target);
    } else {
        throw new Error("Couldn't find release before " + target);
    }
}
