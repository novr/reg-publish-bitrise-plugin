import fs from "fs";
import path from "path";
import * as fflate from "fflate";
import { Configuration, BuildsApi, BuildArtifactApi } from "@novr/bitrise-api";
import { mkdirp } from "mkdirp";

import {
  PublisherPlugin,
  PluginCreateOptions,
  WorkingDirectoryInfo,
} from "reg-suit-interface";
import {
  FileItem,
  RemoteFileItem,
  ObjectListResult,
  AbstractPublisher,
} from "reg-suit-util";

export interface PluginConfig {
  pattern?: string;
  pathPrefix?: string;
  basePath?: string;
  apiKey: string;
  appSlug?: string;
  successOnly?: Boolean;
  artifactName?: string;
}

export class BitrisePublisherPlugin
  extends AbstractPublisher
  implements PublisherPlugin<PluginConfig>
{
  name = "reg-publish-bitrise-plugin";

  private _options!: PluginCreateOptions<any>;
  private _pluginConfig!: PluginConfig;
  private _buildsApi!: BuildsApi;
  private _buildArtifactApi!: BuildArtifactApi;

  constructor() {
    super();
  }

  init(config: PluginCreateOptions<PluginConfig>) {
    this.noEmit = config.noEmit;
    this.logger = config.logger;
    this._options = config;
    this._pluginConfig = {
      ...config.options,
    };
    const configuration = new Configuration({
      basePath: this._pluginConfig.basePath,
      apiKey: this._pluginConfig.apiKey,
    });
    this._buildsApi = new BuildsApi(configuration);
    this._buildArtifactApi = new BuildArtifactApi(configuration);
  }

  protected getAppSlug() {
    if (this._pluginConfig.appSlug) {
      return this._pluginConfig.appSlug;
    } else if (process.env.BITRISE_APP_SLUG) {
      return process.env.BITRISE_APP_SLUG;
    } else {
      throw new Error(`'The appSlug is missing'`);
    }
  }

  protected getArtifactName() {
    return this._pluginConfig.artifactName ?? "artifact";
  }

  protected getBuildDeployDir() {
    if (process.env.BITRISE_DEPLOY_DIR) {
      return process.env.BITRISE_DEPLOY_DIR;
    } else {
      return path.join(this.getWorkingDirs().base, ".deploy");
    }
  }

  protected getHtmlReportDir() {
    if (process.env.BITRISE_HTML_REPORT_DIR) {
      return process.env.BITRISE_HTML_REPORT_DIR;
    } else {
      return path.join(this.getWorkingDirs().base, ".report");
    }
  }

  protected getBuildUrl() {
    return process.env.BITRISE_BUILD_URL;
  }

  override getBucketRootDir(): string | undefined {
    return this._pluginConfig.pathPrefix;
  }

  override getBucketName(): string {
    return this.getAppSlug();
  }

  override getLocalGlobPattern(): string | undefined {
    return this._pluginConfig.pattern;
  }

  override getWorkingDirs(): WorkingDirectoryInfo {
    return this._options.workingDirs;
  }

  publish(key: string) {
    return this.publishInternal(key).then(async (result) => {
      await this.compress(result.items, `${this.getArtifactName()}.zip`);
      const reportUrl = `${this.getBuildUrl()}/?tab=artifacts`;
      return { reportUrl };
    });
  }

  override uploadItem(key: string, item: FileItem): Promise<FileItem> {
    return new Promise(async (resolve, reject) => {
      const itemPath = path.join(this.getHtmlReportDir(), key, item.path);
      await mkdirp(path.dirname(itemPath));
      fs.copyFile(item.absPath, itemPath, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(item);
        }
      });
    });
  }

  protected async compress(
    files: FileItem[],
    filename: string,
    compressOptions: fflate.ZipOptions | undefined = undefined
  ): Promise<FileItem> {
    const options = compressOptions || {};
    const fileContents: Record<string, Uint8Array> = {};

    const readFileSyncAndConvert = (filePath: string): Uint8Array => {
      const data = fs.readFileSync(filePath);
      const arrayBuffer = Uint8Array.from(data).buffer;
      return new Uint8Array(arrayBuffer);
    };

    const promises = files.map(
      (f) => (fileContents[f.path] = readFileSyncAndConvert(f.absPath))
    );

    await mkdirp(this.getBuildDeployDir());
    const zipFile = path.join(this.getBuildDeployDir(), filename);
    try {
      await Promise.all(promises);
      const zippedContent = fflate.zipSync(fileContents, options);
      fs.writeFileSync(zipFile, zippedContent);
      return {
        path: filename,
        absPath: zipFile,
        mimeType: "application/zip",
      } as FileItem;
    } catch (err) {
      throw new Error(`compress failed: ${err}`);
    }
  }

  protected async fetchArtifact(key: string) {
    let next;
    do {
      const builds = await this._buildsApi.buildList({
        appSlug: this.getAppSlug(),
        status: this._pluginConfig.successOnly ? 1 : undefined,
        next: next,
      });
      const targets =
        builds.data?.filter((f) => f.commitHash?.startsWith(key)) ?? [];
      for (const build of targets) {
        if (build.slug) {
          return await this.fetchBuildArtifact(build.slug);
        }
      }
    } while (next);
  }

  protected async fetchBuildArtifact(buildSlug: string) {
    let next;
    do {
      let artifacts = await this._buildArtifactApi.artifactList({
        appSlug: this.getAppSlug(),
        buildSlug: buildSlug,
        next: next,
      });
      const artifact = artifacts.data?.find((f) =>
        f.title?.startsWith(this.getArtifactName())
      );
      if (artifact?.slug) {
        return await this._buildArtifactApi.artifactShow({
          appSlug: this.getAppSlug(),
          buildSlug: buildSlug,
          artifactSlug: artifact.slug,
        });
      }
      next = artifacts.paging?.next;
    } while (next);
  }

  fetch(key: string): Promise<any> {
    if (this.noEmit) return Promise.resolve();
    const progress = this.logger.getProgressBar();
    return new Promise<any>(async (resolve, reject) => {
      progress.start(1, 0);
      this.logger.info(
        `Download 1 files from ${this.logger.colors.magenta(
          this.getBucketName()
        )}.`
      );
      try {
        const artifact = await this.fetchArtifact(key);
        const fileItem = {
          path: "",
          absPath: this.getWorkingDirs().expectedDir,
          mimeType: "",
        } as FileItem;
        if (artifact?.data?.expiringDownloadUrl) {
          const remotePath = artifact?.data?.expiringDownloadUrl;
          await this.downloadItem({ remotePath, key }, fileItem);
          progress.increment(1);
        }
        progress.stop();
        resolve(fileItem);
      } catch (error) {
        reject(error);
      }
    });
  }

  override listItems(
    lastKey: string,
    prefix: string
  ): Promise<ObjectListResult> {
    return Promise.reject(new Error(`listItems: ${lastKey},${prefix}`));
  }

  override downloadItem(
    remoteItem: RemoteFileItem,
    item: FileItem
  ): Promise<FileItem> {
    const actualPrefix = `${path.basename(this.getWorkingDirs().actualDir)}`;
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch(remoteItem.remotePath);
        fflate.unzip(
          new Uint8Array(await response.arrayBuffer()),
          async (err, unzipped) => {
            if (err) {
              reject(err);
            } else {
              const promise = Object.entries(unzipped).map(
                async ([filename, data]) => {
                  const suffix = filename.replace(
                    new RegExp(`^${actualPrefix}\/`),
                    ""
                  );
                  const file = path.join(item.absPath, suffix);
                  await mkdirp(path.dirname(file));
                  fs.writeFileSync(file, data);
                  this.logger.verbose(
                    `Downloaded from ${remoteItem.key} to ${filename}`
                  );
                }
              );
              await Promise.all(promise);
              resolve(item);
            }
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }
}
