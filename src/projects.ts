import log from 'loglevel';
import yaml from 'js-yaml';
import semver from 'semver';
import fsProm from 'fs/promises';
import path from 'path';
import { execFile } from "child_process";

import {
    changeFromPrInfo,
    ChangeType,
    getMergedPrs,
    getPrInfo,
    githubOrgRepoFromDir,
    IChange,
} from "./changes";

export enum BranchMode {
    Exact, // Comparing actual released versions: use the version as-is
    Release, // Comparing a future release on a release branch: compare against tip of the release branch
    Develop, // Comparing a future release where no release branch exists: compare against tip of develop
}

export type ChangesByProject = Record<string, IChange[]>;

export interface SubProjectConfig {
    // Whether to pull all changes in from the subproject by default (true) or exclude them unless
    // they explicitly have notes for this project (false)
    includeByDefault: boolean;
    // Special hack for element-desktop: it wants all changes from element-web but element-web
    // is not in its dependencies. Instead, the version is identical to that of element-desktop.
    mirrorVersion: boolean;
}

export interface ReleaseConfig {
    subprojects: Record<string, SubProjectConfig>;
}

export interface IProject {
    name: string;
    owner: string;
    repo: string;
}

export async function getPackageJsonAtVersion(dir: string, ver: string): Promise<any> {
    const gitShow = v => new Promise((resolve, reject) => {
        execFile('git', ['show', `${v}:package.json`], {
            cwd: dir,
        }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(JSON.parse(stdout));
            }
        });
    });

    // We previously tried this on both origin/${ver} before just $ver to
    // try to avoid you having to make sure your local copies of branches
    // were merged (ie. so 'git fetch' would be fine) but this doesn't work
    // with the release script as-is because it updates version in package.json
    // and then computes the changelog without a push in between, which does
    // feel like a reaosnable thing to do.
    return gitShow(ver);
}

export function branchExists(dir: string, branch: string): Promise<boolean> {
    return new Promise(resolve => {
        execFile('git', ['rev-parse', branch], {
            cwd: dir,
        }, (error) => {
            resolve(!error);
        });
    });
}

function parseDepVersion(ver: string, dep: string): string {
    if (isNaN(parseInt(ver[0]))) throw new Error(`Version ${ver} of dependency ${dep} is not exact!`);

    return 'v' + ver;
}

function getDepVersion(ver: string, proj: string, branchMode: BranchMode) {
    if (branchMode === BranchMode.Develop) {
        return 'develop';
    } else if (branchMode == BranchMode.Release) {
        const depSemVer = semver.parse(ver);
        return `release-v${depSemVer.major}.${depSemVer.minor}.${depSemVer.patch}`;
    } else {
        return parseDepVersion(ver, proj);
    }
}

export function getChangeNotes(change: IChange, projectName: string): string {
    if ([ChangeType.TASK, null].includes(change.changeType)) return null;

    return change.notesByProject[projectName] !== undefined ? change.notesByProject[projectName] : change.notes;
}

export class Project {
    private releaseConfigCache = null;
    public owner: string = null;
    public repo: string = null;

    static async make(name: string, dir: string) {
        const proj = new Project(name, dir);
        await proj.init();
        return proj;
    }

    private constructor(public name: string, public dir: string) {

    }

    private async init() {
        const [owner, repo] = await githubOrgRepoFromDir(this.dir);
        this.owner = owner;
        this.repo = repo;
    }

    public async getReleaseCfg(dir: string): Promise<ReleaseConfig> {
        if (this.releaseConfigCache !== null) return this.releaseConfigCache;

        try {
            this.releaseConfigCache = yaml.load(
                await fsProm.readFile(path.join(dir, 'release_config.yaml')),
            ) as ReleaseConfig;
            if (this.releaseConfigCache.subprojects === undefined) this.releaseConfigCache.subprojects = {};
            return this.releaseConfigCache;
        } catch {
            return { subprojects: {} } as ReleaseConfig;
        }
    }

    private shouldIncludeChange(forProject: Project, change: IChange, includeByDefault: boolean) {
        if (getChangeNotes(change, forProject.name) === null) return false;
        if (change.notesByProject[forProject.name]) return true;

        return includeByDefault;
    }

    public async collectChanges(
        changes: ChangesByProject, fromVer: string, toVer: string, branchMode: BranchMode,
        forProject = this, includeByDefault = true,
    ) {
        if (changes[this.name] !== undefined) return;

        const releaseConfig = await this.getReleaseCfg(this.dir);

        log.debug(`Getting changes in ${this.name} from ${fromVer} to ${toVer}`);
        const mergedPrs = await getMergedPrs(this.dir, fromVer, toVer);
        log.debug("Found set of merged PRs: " + mergedPrs.join(', '));
        log.debug(`Fetching PR metadata from ${this.owner}/${this.repo}...`);
        const prInfo = await getPrInfo(this.owner, this.repo, mergedPrs);

        changes[this.name] = prInfo.map(changeFromPrInfo).map(c => {
            c.shouldInclude = this.shouldIncludeChange(
                forProject, c, includeByDefault,
            );
            return c;
        });

        const subProjects = releaseConfig.subprojects;
        const subProjectVersAtFromVer = {};
        const subProjectVersAtToVer = {};

        if (Object.keys(subProjects).length > 0) {
            const fromVerPackageJson = await getPackageJsonAtVersion(this.dir, fromVer);
            const toVerPackageJson = await getPackageJsonAtVersion(this.dir, toVer);

            for (const proj of Object.keys(subProjects)) {
                if (subProjects[proj].mirrorVersion) {
                    subProjectVersAtFromVer[proj] = fromVer;
                    subProjectVersAtToVer[proj] = toVer;
                } else {
                    subProjectVersAtFromVer[proj] = parseDepVersion(fromVerPackageJson.dependencies[proj], proj);
                    subProjectVersAtToVer[proj] = getDepVersion(
                        toVerPackageJson.dependencies[proj], proj, branchMode,
                    );
                }
                log.debug(
                    `Getting changes for subproject ${proj}: ` +
                    `${subProjectVersAtFromVer[proj]} - ${subProjectVersAtToVer[proj]}`,
                );

                // we assume subprojects have checkouts in the same parent directory
                // as our project, named accordingly
                const subDir = path.normalize(path.join(this.dir, '..', proj));

                const subProject = await Project.make(proj, subDir);
                await subProject.collectChanges(
                    changes, subProjectVersAtFromVer[proj], subProjectVersAtToVer[proj], branchMode,
                    forProject, includeByDefault && subProjects[proj].includeByDefault,
                );
            }
        }
    }
}
