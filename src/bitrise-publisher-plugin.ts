import fs from "fs";
import path from "path";
import * as fflate from "fflate";
import {
  Configuration,
  BuildsApi,
  BuildArtifactApi,
} from "@novr/bitrise-api";
import mkdirp from "mkdirp";
import _ from "lodash";

import { PublisherPlugin, PluginCreateOptions, WorkingDirectoryInfo } from "reg-suit-interface";
import { FileItem, RemoteFileItem, ObjectListResult, AbstractPublisher } from "reg-suit-util";

export interface PluginConfig {
  pattern?: string;
  pathPrefix?: string;
  basePath?: string;
  apiKey: string;
  appSlug?: string;
  successOnly?: Boolean;
  artifactName?: string;
}

export class BitrisePublisherPlugin extends AbstractPublisher implements PublisherPlugin<PluginConfig> {
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

  private getAppSlug() {
    if (this._pluginConfig.appSlug) {
      return this._pluginConfig.appSlug;
    } else if (process.env.BITRISE_APP_SLUG) {
      return process.env.BITRISE_APP_SLUG;
    } else {
      throw new Error(`'The appSlug is missing'`);
    }
  }

  private getArtifactName() {
    return this._pluginConfig.artifactName ?? "artifact";
  }

  private getBuildDeployDir() {
    if (process.env.BITRISE_DEPLOY_DIR) {
      return process.env.BITRISE_DEPLOY_DIR;
    } else {
      return this.getWorkingDirs().base;
    }
  }

  private getBuildUrl() {
    return process.env.BITRISE_BUILD_URL;
  }

  protected getBucketRootDir(): string | undefined {
    return this._pluginConfig.pathPrefix;
  }

  protected getBucketName(): string {
    return this.getAppSlug();
  }

  protected getLocalGlobPattern(): string | undefined {
    return this._pluginConfig.pattern;
  }

  protected getWorkingDirs(): WorkingDirectoryInfo {
    return this._options.workingDirs;
  }

  publish(key: string) {
    return this.publishInternal(key).then(() => {
      const reportUrl = `${this.getBuildUrl()}/?tab=artifacts`;
      return { reportUrl };
    });
  }

  protected createList(): Promise<FileItem[]> {
    return super.createList()
      .then((list) => {
        return this.compress(list, `${this.getArtifactName()}.zip`);
      })
      .then((file) => {
        return [file];
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
  
    const promises = files.map((f) => {
      fileContents[f.path] = readFileSyncAndConvert(f.absPath);
    });
  
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

  protected uploadItem(_key: string, item: FileItem): Promise<FileItem> {
    return Promise.resolve(item);
  }

  fetch(key: string): Promise<any> {
    return this.fetchInternal(key);
  }

  protected listItems(lastKey: string, prefix: string): Promise<ObjectListResult> {
    // Build Success Only by default.
    if (this._pluginConfig.successOnly == undefined) {
      this._pluginConfig.successOnly = true;
    }
    return new Promise<ObjectListResult>(async (resolve, reject) => {
      try {
        const key = prefix.split("/")[0]
        const builds = await this._buildsApi.buildList({
          appSlug: this.getAppSlug(),
          status: this._pluginConfig.successOnly ? 1 : undefined,
          next: lastKey
        });
        const build = builds.data?.find(f => f.commitHash?.string?.startsWith(key));
        let url;
        if (build?.slug) {
          let next = undefined
          let artifact;
          do {
            let artifacts = await this._buildArtifactApi.artifactList({
              appSlug: this.getAppSlug(),
              buildSlug: build.slug,
              next: next
            });
            artifact = artifacts.data?.find(f => f.title?.string?.startsWith(this.getArtifactName()));
            next = artifacts.paging?.next;
          } while (!artifact && next);
          if (artifact?.slug) {
            const item = await this._buildArtifactApi.artifactShow({
              appSlug: this.getAppSlug(),
              buildSlug: build.slug,
              artifactSlug: artifact.slug
            })
            url = item.data?.expiringDownloadUrl
          }
        }
        resolve({
          isTruncated: false,
          contents: !url ? [] : [{ key: url }],
          nextMarker: url ? undefined : builds.paging?.next,
        } as ObjectListResult);
      } catch (error) {
        reject(error);
      }
    });
  }

  protected downloadItem(remoteItem: RemoteFileItem, item: FileItem): Promise<FileItem> {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch(remoteItem.key);
        mkdirp.sync(item.absPath);
        fflate.unzip(new Uint8Array(await response.arrayBuffer()), (err, unzipped) => {
          if (err) {
            reject(err);
          } else {
            Object.entries(unzipped).map(([filename, data]) =>
              fs.writeFileSync(path.join(item.absPath, filename), data),
            );
            resolve(item);
          }
        });        
      } catch (error) {
        reject(error);
      }
    });
  }
}
