import { PublisherPluginFactory } from "reg-suit-interface";
import { BitrisePublisherPlugin } from "./bitrise-publisher-plugin";
import { BitrisePreparer } from "./bitrise-preparer";

const pluginFactory: PublisherPluginFactory = () => {
  return {
    preparer: new BitrisePreparer(),
    publisher: new BitrisePublisherPlugin(),
  };
};

export = pluginFactory;
