import {
  PluginPreparer,
  PluginCreateOptions,
  PluginLogger,
} from "reg-suit-interface";
import { PluginConfig } from "./bitrise-publisher-plugin";

export interface SetupInquireResult {
  apiKey: string;
}

export class BitrisePreparer
  implements PluginPreparer<SetupInquireResult, PluginConfig>
{
  _logger!: PluginLogger;

  inquire() {
    return [
      {
        name: "apiKey",
        type: "input",
        message: "Bitrise API Key",
      },
    ];
  }

  async prepare(config: PluginCreateOptions<SetupInquireResult>) {
    this._logger = config.logger;
    const ir = config.options;
    const pluginConfig: PluginConfig = {
      apiKey: ir.apiKey,
    };
    return pluginConfig;
  }
}
