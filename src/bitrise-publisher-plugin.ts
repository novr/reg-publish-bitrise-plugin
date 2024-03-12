import fs from "fs";
import path from "path";
import * as fflate from "fflate";
import {
  GenericProjectFileShowRequest,
  V0ProjectFileStorageResponseModel,
  GenericProjectFileListRequest,
  V0ProjectFileStorageListResponseModel,
  GenericProjectFilesCreateRequest,
  V0ProjectFileStorageUploadParams,
  GenericProjectFileApi,
  Configuration,
} from "@novr/bitrise-api";
import mkdirp from "mkdirp";
import _ from "lodash";

import { PublisherPlugin, PluginCreateOptions, WorkingDirectoryInfo } from "reg-suit-interface";
import { FileItem, RemoteFileItem, ObjectListResult, AbstractPublisher } from "reg-suit-util";

export interface PluginConfig {
  basePath?: string;
  pattern?: string;
  appSlug: string;
  buildSlug: string;
  apiKey: string;
  customDomain?: string;
  pathPrefix?: string;
}

export class BitrisePublisherPlugin extends AbstractPublisher implements PublisherPlugin<PluginConfig> {
  name = "reg-publish-bitrise-plugin";

  private _options!: PluginCreateOptions<any>;
  private _pluginConfig!: PluginConfig;
  private _bitriseClient!: GenericProjectFileApi;

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
    this._bitriseClient = new GenericProjectFileApi(configuration);
  }

  protected getBucketDomain() {
    if (this._pluginConfig.customDomain) {
      return this._pluginConfig.customDomain;
    } else {
      return `app.bitrise.io`;
    }
  }

  protected getBucketRootDir(): string | undefined {
    return this._pluginConfig.pathPrefix;
  }

  protected getBucketName(): string {
    return this._pluginConfig.appSlug;
  }

  protected getLocalGlobPattern(): string | undefined {
    return this._pluginConfig.pattern;
  }

  protected getWorkingDirs(): WorkingDirectoryInfo {
    return this._options.workingDirs;
  }

  publish(key: string) {
    return this.publishInternal(key).then(({ indexFile }) => {
      const reportUrl = indexFile && `https://${this.getBucketDomain()}/${this.resolveInBucket(key)}/${indexFile.path}`;
      return { reportUrl };
    });
  }

  protected createList(): Promise<FileItem[]> {
    return super.createList()
      .then((list) => {
        return this.compress(list, "files.zip");
      })
      .then((compressedFile) => {
        return [compressedFile];
      });
  }

  protected compress(
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
  
    const zipFile = path.join(this.getWorkingDirs().base, filename);
    return Promise.all(promises)
      .then(() => {
        const zippedContent = fflate.zipSync(fileContents, options);
        fs.writeFileSync(zipFile, zippedContent);
        return {
          path: filename,
          absPath: zipFile,
          mimeType: "application/zip",
        } as FileItem;
      })
      .catch((err) => {
        throw new Error(`compress failed: ${err}`);
      });
  }

  protected uploadItem(key: string, item: FileItem): Promise<FileItem> {
    return new Promise((resolve, reject) => {
      fs.readFile(item.absPath, (err, content) => {
        if (err) return reject(err);
        const file: V0ProjectFileStorageUploadParams = {
          uploadFileName: item.path,
          uploadFileSize: content.length,
          userEnvKey: `${this.resolveInBucket(key)}/${path.basename(this.getWorkingDirs().actualDir)}/${item.path}`
        }
        const req: GenericProjectFilesCreateRequest = {
          appSlug: this._pluginConfig.appSlug,
          genericProjectFile: file
        };
        this._bitriseClient
          .genericProjectFilesCreate(req)
          .then((result) => {
            return fetch(`${result.data!.uploadUrl}`, {
              method: 'POST',
              headers: {
                'Content-Type': item.mimeType
              },
              body: content
            })
          })
          .then(() => {
            this.logger.verbose(`Uploaded from ${item.absPath} to ${key}/${item.path}`);
            return resolve(item);
          })
          .catch(err => {
            return reject(err);
          });
      });
    });
  }

  fetch(key: string): Promise<any> {
    return this.fetchInternal(key);
  }

  protected listItems(lastKey: string, prefix: string): Promise<ObjectListResult> {
    const options: GenericProjectFileListRequest = {
      appSlug: this._pluginConfig.appSlug,
      limit: 50,
    };
    if (lastKey) {
      options.next = lastKey;
    }

    return new Promise<ObjectListResult>((resolve, reject) => {
      this._bitriseClient
        .genericProjectFileList(options)
        .then((result: V0ProjectFileStorageListResponseModel) => {
          resolve({
            isTruncated: false,
            contents: !result.data
              ? []
              : result.data.filter(f => f.userEnvKey?.startsWith(prefix)).map(f => ({ key: f.slug })),
            nextMarker: result.paging?.next,
          } as ObjectListResult);
        })
        .catch(reject);
    });
  }

  protected downloadItem(remoteItem: RemoteFileItem, item: FileItem): Promise<FileItem> {
    const fileSlug = remoteItem.key;
    const request: GenericProjectFileShowRequest = {
      appSlug: this._pluginConfig.appSlug,
      genericProjectFileSlug: fileSlug,
    };
    return new Promise((resolve, reject) => {
      this._bitriseClient
        .genericProjectFileShow(request)
        .then((result: V0ProjectFileStorageResponseModel) => fetch(`${result.data!.downloadUrl}`))
        .then((response: Response) => {
          if (!response.ok) {
            throw new Error(`Failed to download: ${response.statusText}`);
          }
          mkdirp.sync(item.absPath);
          return response.arrayBuffer();
        })
        .then(
          (buffer: ArrayBuffer) =>
            new Promise((resolve, reject) => {
              fflate.unzip(new Uint8Array(buffer), (err, unzipped) => {
                if (err) {
                  reject(err);
                } else {
                  const promises = Object.entries(unzipped).map(([filename, data]) =>
                    fs.writeFileSync(path.join(item.absPath, filename), data),
                  );
                  resolve(Promise.all(promises));
                }
              });
            }),
        )
        .then(() => resolve(item))
        .catch(reject);
    });
  }
}
