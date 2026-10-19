import { BuildError } from './build-contract';
import { inferenceTokenCostMicroUsd, type InferenceTokenUsage } from './inference-pricing';
export {
  inferenceTokenPrices as buildTokenPrices,
  INFERENCE_MARKUP_PERCENT as BUILD_AI_MARKUP_PERCENT,
  inferenceChargeMicroUsd as buildInferenceChargeMicroUsd,
  readInferenceTokenUsage as readBuildTokenUsage,
  type InferenceTokenUsage as BuildTokenUsage,
} from './inference-pricing';

export function buildTokenCostMicroUsd(model: string, usage: InferenceTokenUsage): number {
  try { return inferenceTokenCostMicroUsd(model, usage); }
  catch (error) {
    if (error instanceof Error && error.message === 'inference_model_unpriced') throw new BuildError('build_model_unpriced');
    if (error instanceof Error && error.message === 'inference_usage_invalid') throw new BuildError('build_billing_reconciliation_required');
    throw error;
  }
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
