/** The plugin setup context type, without importing OpenCode internals. */

import { Plugin } from "@opencode/plugin";

type Definition = Parameters<typeof Plugin.define>[0];
export type PluginContext = Parameters<Definition["setup"]>[0];
