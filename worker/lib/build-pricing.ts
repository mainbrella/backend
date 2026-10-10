import { BuildError } from './build-contract';

// Verified 2026-10-10: https://developers.cloudflare.com/workers-ai/platform/pricing/
// Micro-USD per million tokens. Use the greater of the advertised token rate
// and the neuron equivalent ($0.011 / 1,000 neurons), so rounding cannot leave
// us below Cloudflare's bill. Free account-wide allowances are not assumed.
export const buildTokenPrices: Record<string, { input: number; cached: number; output: number }> = {
  '@cf/zai-org/glm-5.3-flash': { input: 150_000, cached: 30_000, output: 500_005 },
  '@cf/zai-org/glm-5.3': { input: 1_400_003, cached: 260_000, output: 4_400_000 },
  '@cf/zai-org/glm-5.2': { input: 1_400_003, cached: 260_000, output: 4_400_000 },
  '@cf/zai-org/glm-4.7-flash': { input: 60_500, cached: 60_500, output: 400_400 },
  '@cf/moonshotai/kimi-k2.5': { input: 600_000, cached: 100_001, output: 3_000_000 },
  '@cf/qwen/qwen2.5-coder-32b-instruct': { input: 660_000, cached: 660_000, output: 1_000_000 },
  '@cf/openai/gpt-oss-120b': { input: 350_000, cached: 350_000, output: 750_002 },
};
export type BuildTokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export const BUILD_AI_MARKUP_PERCENT = 50;
export const buildInferenceChargeMicroUsd = (providerCostMicroUsd: number) => Math.ceil(providerCostMicroUsd * 1.5);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function readBuildTokenUsage(value: any): BuildTokenUsage | null {
  if (!count(value?.prompt_tokens) || !count(value?.completion_tokens)) return null;
  const cached = value.prompt_tokens_details?.cached_tokens ?? 0;
  if (!count(cached) || cached > value.prompt_tokens) return null;
  return { inputTokens: value.prompt_tokens, cachedInputTokens: cached, outputTokens: value.completion_tokens };
}
export function buildTokenCostMicroUsd(model: string, usage: BuildTokenUsage): number {
  const price = buildTokenPrices[model];
  if (!price) throw new BuildError('build_model_unpriced');
  if (!count(usage.inputTokens) || !count(usage.cachedInputTokens) || !count(usage.outputTokens)
    || usage.cachedInputTokens > usage.inputTokens) throw new BuildError('build_billing_reconciliation_required');
  const total = BigInt(usage.inputTokens - usage.cachedInputTokens) * BigInt(price.input)
    + BigInt(usage.cachedInputTokens) * BigInt(price.cached) + BigInt(usage.outputTokens) * BigInt(price.output);
  // Round only to one millionth of a dollar, never to a whole credit/cent.
  return Number((total + 999_999n) / 1_000_000n);
}
export const BUILD_IMAGE_WIDTH = 1024;
export const BUILD_IMAGE_HEIGHT = 1024;
export const BUILD_IMAGE_STEPS = 4;
// Flux Schnell: $0.0000528 / 512² tile + $0.0001056 / step.
export function buildImageCostMicroUsd(width: number, height: number, steps = BUILD_IMAGE_STEPS) {
  if (![width, height, steps].every(value => Number.isSafeInteger(value) && value > 0)) throw new BuildError('build_image_invalid');
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  return Math.ceil((528 * tiles + 1056 * steps) / 10);
}
export const BUILD_IMAGE_COST_MICRO_USD = buildImageCostMicroUsd(BUILD_IMAGE_WIDTH, BUILD_IMAGE_HEIGHT);
