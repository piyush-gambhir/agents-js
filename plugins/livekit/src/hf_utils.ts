// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommitInfo, PathInfo, RepoDesignation } from '@huggingface/hub';
import { downloadFile, listCommits, pathsInfo } from '@huggingface/hub';
import { log } from '@livekit/agents';
import { createWriteStream, writeFileSync } from 'node:fs';
import { lstat, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

interface CredentialsParams {
  accessToken?: string;
}

export const REGEX_COMMIT_HASH: RegExp = new RegExp('^[0-9a-f]{40}$');

function getHFHubCachePath(customCacheDir?: string): string {
  return customCacheDir || join(homedir(), '.cache', 'huggingface', 'hub');
}

function getRepoFolderName(repoId: string): string {
  return `models--${repoId.replace(/\//g, '--')}`;
}

function toRepoId(repo: RepoDesignation | string): string {
  if (typeof repo === 'string') {
    return repo;
  }
  return `${repo.name}`;
}

async function getBranchHeadCommit(
  repo: RepoDesignation,
  revision: string,
  params: { accessToken?: string; hubUrl?: string; fetch?: typeof fetch },
): Promise<string | null> {
  const logger = log();

  try {
    if (REGEX_COMMIT_HASH.test(revision)) {
      return revision;
    }

    for await (const commit of listCommits({
      repo,
      revision,
      ...params,
    })) {
      const commitHash = (commit as any).oid || (commit as any).id || (commit as any).commitId;
      if (commitHash) {
        return commitHash;
      }
      break;
    }

    logger.error({ repo: toRepoId(repo), revision }, 'No commits found for revision');
    return null;
  } catch (error) {
    logger.error(
      { error: (error as Error).message, repo: toRepoId(repo), revision },
      'Error getting HEAD commit',
    );
    throw error;
  }
}

async function createSymlink(sourcePath: string, targetPath: string): Promise<void> {
  const logger = log();
  const { symlink, rm, copyFile } = await import('node:fs/promises');

  function expandUser(path: string): string {
    if (path.startsWith('~')) {
      return path.replace('~', homedir());
    }
    return path;
  }

  const absSrc = resolve(expandUser(sourcePath));
  const absDst = resolve(expandUser(targetPath));

  try {
    await rm(absDst);
  } catch {
  }

  try {
    const relativePath = relative(dirname(absDst), absSrc);
    await symlink(relativePath, absDst);
    logger.debug({ source: absSrc, target: absDst, relative: relativePath }, 'Created symlink');
  } catch (symlinkError) {
    logger.warn({ source: absSrc, target: absDst }, 'Symlink not supported, falling back to copy');
    try {
      await copyFile(absSrc, absDst);
      logger.debug({ source: absSrc, target: absDst }, 'File copied successfully');
    } catch (copyError) {
      logger.error(
        { error: (copyError as Error).message, source: absSrc, target: absDst },
        'Failed to copy file',
      );
      throw symlinkError;
    }
  }
}

function getFilePointer(storageFolder: string, revision: string, relativeFilename: string): string {
  const snapshotPath = join(storageFolder, 'snapshots');
  return join(snapshotPath, revision, relativeFilename);
}

async function exists(path: string, followSymlinks?: boolean): Promise<boolean> {
  try {
    if (followSymlinks) {
      await stat(path);
    } else {
      await lstat(path);
    }
    return true;
  } catch (err: unknown) {
    return false;
  }
}

async function saveRevisionMapping({
  storageFolder,
  revision,
  commitHash,
}: {
  storageFolder: string;
  revision: string;
  commitHash: string;
}): Promise<void> {
  if (!REGEX_COMMIT_HASH.test(revision) && revision !== commitHash) {
    const refsPath = join(storageFolder, 'refs');
    await mkdir(refsPath, { recursive: true });
    writeFileSync(join(refsPath, revision), commitHash);
  }
}

export async function downloadFileToCacheDir(
  params: {
    repo: RepoDesignation;
    path: string;
    raw?: boolean;
    revision?: string;
    hubUrl?: string;
    cacheDir?: string;
    fetch?: typeof fetch;
    localFileOnly?: boolean;
  } & Partial<CredentialsParams>,
): Promise<string> {
  const logger = log();

  const revision = params.revision ?? 'main';
  const cacheDir = params.cacheDir ?? getHFHubCachePath();
  const repoId = toRepoId(params.repo);
  const storageFolder = join(cacheDir, getRepoFolderName(repoId));

  let branchHeadCommit: string | undefined;

  if (REGEX_COMMIT_HASH.test(revision)) {
    branchHeadCommit = revision;
    const pointerPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(pointerPath, true)) {
      logger.debug(
        { pointerPath, commitHash: branchHeadCommit },
        'File found in cache (commit hash)',
      );
      return pointerPath;
    }
  }

  if (params.localFileOnly) {
    logger.debug({ repoId, path: params.path, revision }, 'Local file only mode - checking cache');

    const directPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(directPath, true)) {
      logger.debug({ directPath }, 'File found in cache (direct path)');
      return directPath;
    }

    if (!REGEX_COMMIT_HASH.test(revision)) {
      const refsPath = join(storageFolder, 'refs', revision);
      try {
        const { readFileSync } = await import('fs');
        const resolvedHash = readFileSync(refsPath, 'utf-8').trim();
        const resolvedPath = getFilePointer(storageFolder, resolvedHash, params.path);
        if (await exists(resolvedPath, true)) {
          logger.debug({ resolvedPath, resolvedHash }, 'File found in cache (via refs)');
          return resolvedPath;
        }
      } catch {
        logger.debug({ revision }, 'No ref mapping found for revision');
      }
    }

    const error = `File not found in cache: ${repoId}/${params.path} (revision: ${revision}). Make sure to run the download-files command before running the agent worker.`;
    logger.error({ repoId, path: params.path, revision }, error);
    throw new Error(error);
  }

  if (!branchHeadCommit) {
    const headCommit = await getBranchHeadCommit(params.repo, revision, params);
    if (!headCommit) {
      throw new Error(`Failed to resolve revision ${revision} to commit hash`);
    }
    branchHeadCommit = headCommit;
  }

  const pointerPath = getFilePointer(storageFolder, branchHeadCommit, params.path);
  if (await exists(pointerPath, true)) {
    logger.debug({ pointerPath, branchHeadCommit }, 'File found in cache (branch HEAD)');

    await saveRevisionMapping({
      storageFolder,
      revision,
      commitHash: branchHeadCommit,
    });

    return pointerPath;
  }

  logger.debug(
    { repoId, path: params.path, revision: branchHeadCommit },
    'Fetching path info from HF API',
  );
  const pathsInformation: (PathInfo & { lastCommit: CommitInfo })[] = await pathsInfo({
    ...params,
    paths: [params.path],
    revision: branchHeadCommit,
    expand: true,
  });

  if (!pathsInformation || pathsInformation.length !== 1) {
    const error = `cannot get path info for ${params.path}`;
    logger.error({ repoId, path: params.path, pathsInfoLength: pathsInformation?.length }, error);
    throw new Error(error);
  }

  const pathInfo = pathsInformation[0];
  if (!pathInfo) {
    const error = `No path info returned for ${params.path}`;
    logger.error({ repoId, path: params.path }, error);
    throw new Error(error);
  }

  let etag: string;
  if (pathInfo.lfs) {
    etag = pathInfo.lfs.oid;
    logger.debug({ etag, path: params.path }, 'File is LFS pointer');
  } else {
    etag = pathInfo.oid;
    logger.debug({ etag, path: params.path }, 'File is regular git object');
  }

  const blobPath = join(storageFolder, 'blobs', etag);

  logger.debug({ branchHeadCommit, pointerPath, blobPath }, 'Computed cache paths');

  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  if (await exists(blobPath)) {
    logger.debug({ blobPath, etag }, 'Blob already exists in cache, creating symlink only');
    await createSymlink(blobPath, pointerPath);
    return pointerPath;
  }

  const incomplete = `${blobPath}.incomplete`;
  logger.debug({ path: params.path, incomplete }, 'Starting file download');

  const blob: Blob | null = await downloadFile({
    ...params,
    revision: branchHeadCommit,
  });

  if (!blob) {
    const error = `invalid response for file ${params.path}`;
    logger.error({ path: params.path }, error);
    throw new Error(error);
  }

  logger.debug({ size: blob.size }, 'Writing blob to disk');
  await pipeline(Readable.fromWeb(blob.stream() as ReadableStream), createWriteStream(incomplete));

  await rename(incomplete, blobPath);
  logger.debug({ blobPath }, 'Renamed incomplete file to final blob');

  await createSymlink(blobPath, pointerPath);
  logger.debug({ blobPath, pointerPath }, 'Created symlink from snapshot to blob');

  await saveRevisionMapping({
    storageFolder,
    revision,
    commitHash: branchHeadCommit,
  });

  logger.debug({ pointerPath, size: blob.size }, 'File download completed successfully');
  return pointerPath;
}
