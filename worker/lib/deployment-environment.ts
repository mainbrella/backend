export type DeploymentEnvironment = Pick<Env, 'DEPLOYMENT_ENVIRONMENT'>;

export function isStaging(env?: DeploymentEnvironment): boolean {
  return env?.DEPLOYMENT_ENVIRONMENT === 'staging';
}

export function publicApiOrigin(env?: DeploymentEnvironment): string {
  return isStaging(env) ? 'https://api-stg.mainbrella.com' : 'https://api.mainbrella.com';
}

export function publicWebOrigin(env?: DeploymentEnvironment): string {
  return isStaging(env) ? 'https://stg.mainbrella.com' : 'https://mainbrella.com';
}

export function emailDeliveryEnabled(env: DeploymentEnvironment & Pick<Env, 'EMAIL_DELIVERY_ENABLED'>): boolean {
  return !isStaging(env) && env.EMAIL_DELIVERY_ENABLED !== 'false';
}
