import { BuildError, BUILD_MODEL } from './build-contract';

// Workers AI tool-calling text models, verified 2026-10-10 against
// https://developers.cloudflare.com/workers-ai/models/ and each model's input schema.
// Use real modes, rather than compatibility aliases that silently map to another effort.
export type BuildModel = { id: string; name: string; description?: string; efforts: string[]; defaultEffort: string; reasoning: 'effort' | 'toggle' | 'nemotron' | 'fixed' };
// Retain native modes for builds already queued with older choices.
const supportedModels: BuildModel[] = [
  { id: '@cf/zai-org/glm-5.3-flash', name: 'GLM-5.3 Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/zai-org/glm-5.3', name: 'GLM-5.3', efforts: ['low', 'high', 'max'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/zai-org/glm-5.2', name: 'GLM-5.2', efforts: ['none', 'high', 'max'], defaultEffort: 'high', reasoning: 'effort' },
  { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7 Flash', efforts: ['none', 'on'], defaultEffort: 'on', reasoning: 'toggle' },
  { id: '@cf/moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code', efforts: ['always'], defaultEffort: 'always', reasoning: 'fixed' },
  { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', efforts: ['none', 'high'], defaultEffort: 'high', reasoning: 'effort' },
  { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B', efforts: ['none', 'on'], defaultEffort: 'on', reasoning: 'toggle' },
  { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'low', reasoning: 'effort' },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen 3 30B A3B', efforts: ['default'], defaultEffort: 'default', reasoning: 'fixed' },
  { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 Super', efforts: ['none', 'low', 'on'], defaultEffort: 'low', reasoning: 'nemotron' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', efforts: ['unsupported'], defaultEffort: 'unsupported', reasoning: 'fixed' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', efforts: ['unsupported'], defaultEffort: 'unsupported', reasoning: 'fixed' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1', efforts: ['unsupported'], defaultEffort: 'unsupported', reasoning: 'fixed' },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0 H Micro', efforts: ['unsupported'], defaultEffort: 'unsupported', reasoning: 'fixed' },
];
// A short, quality-first product menu, rather than the provider's full catalog.
export const buildModels: BuildModel[] = [
  { id: BUILD_MODEL, name: 'GLM-5.3', description: 'Best quality', efforts: ['high', 'max'], defaultEffort: 'high', reasoning: 'effort' },
  { id: '@cf/moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Coding', efforts: ['always'], defaultEffort: 'always', reasoning: 'fixed' },
  { id: '@cf/zai-org/glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Lower cost', efforts: ['high', 'max'], defaultEffort: 'high', reasoning: 'effort' },
];
export function resolveBuildModel(defaultModel: string, options: { model?: string; effort?: string }, local = false) {
  const model = options.model ?? defaultModel;
  const definition = local ? model === defaultModel ? { defaultEffort: 'low', efforts: ['low'] } : undefined : buildModels.find(item => item.id === model);
  if (!definition) throw new BuildError('invalid_build_model', 400);
  const effort = options.effort ?? definition.defaultEffort;
  if (!definition.efforts.includes(effort)) throw new BuildError('invalid_build_effort', 400);
  return { model, effort };
}
export function buildReasoningOptions(model: string, effort?: string | null): Record<string, unknown> {
  const definition = supportedModels.find(item => item.id === model);
  if (!definition) return {}; // Existing deployment-controlled models remain readable.
  const selected = effort ?? buildModels.find(item => item.id === model)?.defaultEffort ?? definition.defaultEffort;
  if (!definition.efforts.includes(selected)) throw new BuildError('invalid_build_effort', 400);
  if (definition.reasoning === 'effort') return { reasoning_effort: selected };
  if (definition.reasoning === 'toggle') return { chat_template_kwargs: { enable_thinking: selected !== 'none' } };
  if (definition.reasoning === 'nemotron') return { chat_template_kwargs: { enable_thinking: selected !== 'none', low_effort: selected === 'low', force_nonempty_content: true } };
  return {};
}
