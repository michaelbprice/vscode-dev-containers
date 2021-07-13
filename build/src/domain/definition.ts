/*--------------------------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://go.microsoft.com/fwlink/?linkid=2090316 for license information.
 *-------------------------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { jsonc } from 'jsonc';
import { Component, Lookup } from './common';
import * as asyncUtils from '../utils/async';
import { getConfig } from '../utils/config';

export interface Dependency {
    name: string;
    cgIgnore?: boolean;
    markdownIgnore?: boolean;
    annotation?: string;
}

export interface OtherDependency extends Dependency {
    path?: string;
    versionCommand?: string;
    downloadUrl?: string;
}

export interface BuildSettings {
    rootDistro: string;
    tags: string[];
    variantTags?: Lookup<string[]> 
    parent?: Lookup<string> | string;
    parentVariant?: Lookup<string> | string;
    latest?: string;
    versionedTagsOnly?: boolean;
}

export interface DefinitionVariant {
    definition: Definition;
    variant?: string;
}

export interface Dependencies {
    image: string;
    imageLink: string;
    annotation?: string;
    apt?: (Dependency | string)[];
    pip?: string[];
    pipx?: string[];
    git?: Lookup<string>;
    gem?: string[];
    cargo?: Lookup<string | null>;
    go?: Lookup<string | null>;
    npm?: string[];
    other?: Lookup<OtherDependency | null>;
    languages?: Lookup<OtherDependency | null>;
    imageVariants?: string[];
    manual?: Component[];
}

export class Definition {
    id: string;
    definitionVersion: string;
    variants: string[];
    build: BuildSettings;
    dependencies?: Dependencies;
    devcontainerJson?: {};
    devcontainerJsonString?: string;
    hasManifest: boolean = false;
    hasBaseDockerfile: boolean = false;

    // Parent is either a single definition or a lookup of variants to definitions
    parentDefinitions?: Map<string | undefined, DefinitionVariant>;
    childDefinitions?: Definition[];

    path: string;
    relativePath: string;
    repositoryPath: string;
    libraryScriptsPath: string;

    constructor(id: string, definitionPath: string, repositoryPath: string) {
        this.id = id;
        this.repositoryPath = repositoryPath;
        this.path = definitionPath;
        this.relativePath = path.relative(this.repositoryPath, this.path);
    }

    // Loads definition-manifest.json, devcontainer.json
    async load(): Promise<void> {
        const manifestPath = path.join(this.path, getConfig('definitionBuildConfigFile', 'definition-manifest.json'));
        if(await asyncUtils.exists(manifestPath)) {
            this.hasManifest = true;
            const definitionManifest = await jsonc.read(manifestPath);
            Object.assign(this, definitionManifest);
        }
        this.devcontainerJsonString = await asyncUtils.readFile(path.join(this.path, '.devcontainer', 'devcontainer.json'));
        this.devcontainerJson = jsonc.parse(this.devcontainerJsonString);
        this.hasBaseDockerfile = await asyncUtils.exists(path.join(this.path,'.devcontainer', 'base.Dockerfile'));
        const libraryScriptsPath = path.join(this.path,'.devcontainer', 'base.Dockerfile');
        if (await asyncUtils.exists(libraryScriptsPath)) {
            this.libraryScriptsPath = libraryScriptsPath;
        }

    }

    // Generate 'latest' flavor of a given definition's tag
    getLatestTags(registry: string, registryPath: string): string[] {
        // Given there could be multiple registries in the tag list, get all the different latest variations
        return this.build.tags.reduce((list, tag) => {
            const latest = `${registry}/${registryPath}/${tag.replace(/:.+/, ':latest')}`
            if (list.indexOf(latest) < 0) {
                list.push(latest);
            }
            return list;
        }, []);
    }

    // Create all the needed variants of the specified version identifier for a given definition
    getTagsForRelease(versionOrRelease: string, registry: string, repository: string, variant?: string): string[] {
        let version = this.getVersionForRelease(versionOrRelease);
        // If the definition states that only versioned tags are returned and the version is 'dev', 
        // add the definition Id to ensure that we do not incorrectly hijack a tag from another definition.
        if (version === 'dev') {
            version = this.build.versionedTagsOnly ? `dev-${this.id.replace(/-/mg,'')}` : 'dev';
        }

        // Use the first variant if none passed in, unless there isn't one
        if (!variant) {
            variant = this.variants ? this.variants[0] : 'NOVARIANT';
        }
        let tags = this.build.tags;

        // See if there are any variant specific tags that should be added to the output
        const variantTags = this.build.variantTags;
        // ${VARIANT} or $VARIANT may be passed in as a way to do lookups. Add all in this case.
        if (['${VARIANT}', '$VARIANT'].indexOf(variant) > -1) {
            if (variantTags) {
                for (let variantEntry in variantTags) {
                    tags = tags.concat(variantTags[variantEntry] || []);
                }
            }
        } else {
            if (variantTags) {
                tags = tags.concat(variantTags[variant] || []);
            }
        }

        return tags.reduce((list, tag) => {
            // One of the tags that needs to be supported is one where there is no version, but there
            // are other attributes. For example, python:3 in addition to python:0.35.0-3. So, a version
            // of '' is allowed. However, there are also instances that are just the version, so in 
            // these cases latest would be used instead. However, latest is passed in separately.
            let baseTag = tag.replace('${VERSION}', version)
                .replace(':-', ':')
                .replace(/\$\{?VARIANT\}?/, variant || 'NOVARIANT')
                .replace('-NOVARIANT', '');
            if (baseTag.charAt(baseTag.length - 1) !== ':') {
                list.push(`${registry}/${repository}/${baseTag}`);
            }
            return list;
        }, []);
    }

    // Convert a release string (v1.0.0) or branch (main) into a version. If a definitionId and 
    // release string is passed in, use the version specified in defintion-manifest.json if one exists.
    getVersionForRelease(versionOrRelease: string): string {
        // Already is a version
        if (!isNaN(parseInt(versionOrRelease.charAt(0)))) {
            return this.definitionVersion || versionOrRelease;
        }
        // Is a release string
        if (versionOrRelease.charAt(0) === 'v' && !isNaN(parseInt(versionOrRelease.charAt(1)))) {
            return this.definitionVersion || versionOrRelease.substr(1);
        }
        // Is a branch
        return 'dev';
    }

    // Get the major part of the version number
    majorVersionPartForRelease(versionOrRelease: string): string {
        const version = this.getVersionForRelease(versionOrRelease);
        if (version === 'dev') {
            return 'dev';
        }
        const versionParts = version.split('.');
        return versionParts[0];
    }

    /* 
    Generate complete list of tags for a given definition.

    versionPartHandling has a few different modes:
        - true/'all-latest' - latest, X.X.X, X.X, X
        - false/'all' - X.X.X, X.X, X
        - 'full-only' - X.X.X
        - 'major-minor' - X.X
        - 'major' - X
    */
    getTagList(releaseOrVersion: string, versionPartHandling: string | boolean, registry: string, repository: string, variant?: string): string[] {
        const version = this.getVersionForRelease(releaseOrVersion);

        // If version is 'dev', there's no need to generate semver tags for the version
        // (e.g. for 1.0.2, we should also tag 1.0 and 1). So just return the tags for 'dev'.
        if (version === 'dev') {
            return this.getTagsForRelease(version, registry, repository, variant);
        }

        // If this is a release version, split it out into the three parts of the semver
        const versionParts = version.split('.');
        if (versionParts.length !== 3) {
            throw (`Invalid version format in ${version}.`);
        }

        let versionList: string[], updateUnversionedTags: boolean, updateLatest: boolean;
        switch(versionPartHandling) {
            case true:
            case 'all-latest':
                updateLatest = true; 
                updateUnversionedTags = true;
                versionList = [version,`${versionParts[0]}.${versionParts[1]}`, `${versionParts[0]}` ];
                break;
            case false:
            case 'all':
                updateLatest = false;
                updateUnversionedTags = true;
                versionList = [version,`${versionParts[0]}.${versionParts[1]}`, `${versionParts[0]}` ];
                break;
            case 'full-only':
                updateLatest = false;
                updateUnversionedTags = false;
                versionList = [version];
                break;
            case 'major-minor':
                updateLatest = false;
                updateUnversionedTags = false;
                versionList = [`${versionParts[0]}.${versionParts[1]}`];
                break;
            case 'major':
                updateLatest = false;
                updateUnversionedTags = false;
                versionList = [ `${versionParts[0]}`];
                break;
        }

        // Normally, we also want to return a tag without a version number, but for
        // some definitions that exist in the same repository as others, we may
        // only want to return a list of tags with part of the version number in it
        if(updateUnversionedTags && !this.build.versionedTagsOnly) {
            // This is the equivalent of latest for qualified tags- e.g. python:3 instead of python:0.35.0-3
            versionList.push(''); 
        }

        const firstVariant = this.variants ? this.variants[0] : variant;
        let tagList = [];

        versionList.forEach((tagVersion: string) => {
            tagList = tagList.concat(this.getTagsForRelease(tagVersion, registry, repository, variant));
        });

        // If this variant should also be used for the the latest tag (it's the left most in the list), add it
        return tagList.concat((updateLatest 
            && this.build.latest
            && variant === firstVariant)
            ? this.getLatestTags(registry, repository)
            : []);
    }

    // Get parent tag for a given child definition
    getParentTagForRelease(releaseOrVersion: string, registry: string, repository: string, variant?: string) {
        const version = this.getVersionForRelease(releaseOrVersion);

        if(!this.parentDefinitions) {
            return null;
        }
        if(!variant && this.variants) {
            variant = this.variants[0];
        }
        const parent = this.parentDefinitions.get(variant);
        return parent.definition.getTagsForRelease(
            parent.definition.definitionVersion || version, 
            registry,
            repository,
            parent.variant)[0];
    }

    // Get the path to the dockerfile for the definitions
    async getDockerfilePath(userDockerfile: boolean = false) {
        if(!userDockerfile && this.hasBaseDockerfile) {
            return path.join(this.path,'.devcontainer', 'base.Dockerfile');
        }
        const dockerFilePath = path.join(this.path, '.devcontainer', 'Dockerfile');
        if (await asyncUtils.exists(dockerFilePath)) {
            return dockerFilePath;
        }
    }

    // Write an updated devcontainer json file and store any changes in the object
    async updateDevcontainerJson(content: string) {
        this.devcontainerJsonString = content;
        this.devcontainerJson = jsonc.parse(content);
        await asyncUtils.writeFile(path.join(this.path, '.devcontainer', 'devcontainer.json') ,content);
    }

    // Read the dockerfile for the definition
    async readDockerfile(userDockerfile: boolean=false): Promise<string> {
        return await asyncUtils.readFile(await this.getDockerfilePath(userDockerfile));
    }

    // Read the dockerfile for the definition
    async writeDockerfile(content: string, userDockerfile: boolean=false): Promise<void> {
        await asyncUtils.writeFile(await this.getDockerfilePath(userDockerfile),content);
    }

}
