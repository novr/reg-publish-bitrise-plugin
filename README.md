# reg-publish-bitrise-plugin

reg-suit plugin to fetch and publish snapshot images to Bitrise.

## Install

```sh
npm i reg-publish-bitrise-plugin -D
reg-suit prepare -p publish-bitrise
```

## Requirements

To use this plugin, you need to create an bitrise API token.

## Configure

```ts
{
  apiKey: string;
  basePath?: string;
  appSlug?: string;
  successOnly?: boolean;
  artifactName?: string;
}
```

- `apiKey` - _Required_ - The API key for authenticating requests to the Bitrise API.
- `basePath` - _Optional_ - The base path of the Bitrise API. Defaults to "https://api.bitrise.io/v0.1".
- `appSlug` - _Required_ - Bitrise application slug. Default ${BITRISE_APP_SLUG}.
- `successOnly` - _Optional_ - A flag indicating whether to retrieve only successful builds. Defaults `true`.
- `artifactName` - _Optional_ - Specify artifact file name. Defaults `artifact`.

## Limitations

- [reg-keygen-git-hash-plugin](https://github.com/reg-viz/reg-suit/tree/master/packages/reg-keygen-git-hash-plugin) is required as a plugin.
- [steps-deploy-to-bitrise-io](https://github.com/bitrise-steplib/steps-deploy-to-bitrise-io) after the report in the bitrise workflow.
