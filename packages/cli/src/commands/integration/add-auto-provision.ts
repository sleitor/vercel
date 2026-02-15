import chalk from 'chalk';
import open from 'open';
import output from '../../output-manager';
import type Client from '../../util/client';
import getScope from '../../util/get-scope';
import { autoProvisionResource } from '../../util/integration/auto-provision-resource';
import { fetchIntegrationWithTelemetry } from '../../util/integration/fetch-integration';
import { fetchInstallations } from '../../util/integration/fetch-installations';
import { promptForTermAcceptance } from '../../util/integration/prompt-for-terms';
import { selectProduct } from '../../util/integration/select-product';
import type {
  AcceptedPolicies,
  AutoProvisionResult,
} from '../../util/integration/types';
import { resolveResourceName } from '../../util/integration/generate-resource-name';
import {
  getLinkedProjectField,
  postProvisionSetup,
  type PostProvisionOptions,
} from '../../util/integration/post-provision-setup';
import {
  IntegrationAddTelemetryClient,
  type MarketplaceEventProperties,
} from '../../util/telemetry/commands/integration/add';
import {
  parseMetadataFlags,
  validateAndPrintRequiredMetadata,
} from '../../util/integration/parse-metadata';
import type { Metadata } from '../../util/integration/types';

export interface AddAutoProvisionOptions extends PostProvisionOptions {
  metadata?: string[];
  productSlug?: string;
  billingPlanId?: string;
}

export async function addAutoProvision(
  client: Client,
  integrationSlug: string,
  resourceNameArg?: string,
  options: AddAutoProvisionOptions = {}
) {
  const telemetry = new IntegrationAddTelemetryClient({
    opts: {
      store: client.telemetryEventStore,
    },
  });
  telemetry.trackCliOptionName(resourceNameArg);
  telemetry.trackCliOptionMetadata(options.metadata);
  telemetry.trackCliFlagNoConnect(options.noConnect);
  telemetry.trackCliFlagNoEnvPull(options.noEnvPull);
  telemetry.trackCliOptionPlan(options.billingPlanId);
  telemetry.trackCliOptionEnvironment(options.environments);

  // 1. Get team context
  const { contextName, team } = await getScope(client);
  if (!team) {
    output.error('Team not found');
    return 1;
  }

  // 2. Fetch integration
  const integration = await fetchIntegrationWithTelemetry(
    client,
    integrationSlug,
    telemetry
  );
  if (!integration) {
    return 1;
  }

  if (!integration.products?.length) {
    output.error(
      `Integration "${integrationSlug}" is not a Marketplace integration`
    );
    return 1;
  }

  // 3. Select product (by slug, single auto-select, or interactive prompt in TTY)
  if (
    !options.productSlug &&
    integration.products.length > 1 &&
    !client.stdin.isTTY
  ) {
    const choices = integration.products
      .map(p => `  ${integrationSlug}/${p.slug}`)
      .join('\n');
    output.error(
      `Integration "${integrationSlug}" has multiple products. Specify one with:\n\n${choices}\n\nExample: vercel integration add ${integrationSlug}/${integration.products[0].slug}`
    );
    return 1;
  }

  // Select product and check installations in parallel
  const [productResult, installationsResult] = await Promise.allSettled([
    selectProduct(client, integration.products, options.productSlug),
    fetchInstallations(client, integration),
  ]);

  if (productResult.status === 'rejected') {
    output.error(
      `Failed to select product: ${(productResult.reason as Error).message}`
    );
    return 1;
  }

  if (!productResult.value) {
    return 1;
  }

  if (installationsResult.status === 'rejected') {
    output.error(
      `Failed to get integration installations: ${(installationsResult.reason as Error).message}`
    );
    return 1;
  }

  const product = productResult.value;
  const installations = installationsResult.value;

  const marketplaceProps: MarketplaceEventProperties = {
    integration_id: integration.id,
    integration_slug: integration.slug,
    integration_name: integration.name,
    product_id: product.id,
    product_slug: product.slug,
    is_from_cli: true,
    is_cli_auto_provision: true,
  };

  telemetry.trackInstallFlowStarted(marketplaceProps);

  output.log(
    `Installing ${chalk.bold(product.name)} by ${chalk.bold(integration.name)} under ${chalk.bold(contextName)}`
  );
  output.debug(`Selected product: ${product.slug} (id: ${product.id})`);
  output.debug(
    `Product metadataSchema: ${JSON.stringify(product.metadataSchema, null, 2)}`
  );

  // 3b. Check if integration is installed on this team
  const teamInstallation = installations.find(
    i => i.ownerId === team.id && i.installationType === 'marketplace'
  );

  let acceptedPolicies: AcceptedPolicies = {};
  if (!teamInstallation) {
    const policies = await promptForTermAcceptance(client, integration);
    if (!policies) {
      telemetry.trackInstallFlowWebFallback({
        ...marketplaceProps,
        reason: 'policy_declined',
      });
      return 1;
    }
    acceptedPolicies = policies;
  }

  // 4. Validate metadata flags (if provided) BEFORE prompting for resource name
  let metadata: Metadata;
  if (options.metadata?.length) {
    // Parse metadata from CLI flags
    output.debug(
      `Parsing metadata from flags: ${JSON.stringify(options.metadata)}`
    );
    const { metadata: parsed, errors } = parseMetadataFlags(
      options.metadata,
      product.metadataSchema
    );
    if (errors.length) {
      for (const error of errors) {
        output.error(error);
      }
      return 1;
    }
    // Validate all required fields are present
    if (!validateAndPrintRequiredMetadata(parsed, product.metadataSchema)) {
      return 1;
    }
    metadata = parsed;
  } else {
    // No --metadata flags: pass {} and let server fill defaults (API PR #58905)
    metadata = {};
  }

  // 5. Resolve and validate resource name
  const nameResult = resolveResourceName(product.slug, resourceNameArg);
  if ('error' in nameResult) {
    output.error(nameResult.error);
    return 1;
  }
  const { resourceName } = nameResult;

  output.debug(`Collected metadata: ${JSON.stringify(metadata)}`);
  output.debug(`Resource name: ${resourceName}`);

  // 6. Track plan selection (server decides plan in auto-provision unless --plan flag)
  telemetry.trackCheckoutPlanSelected({
    ...marketplaceProps,
    billing_plan_id: options.billingPlanId,
    plan_selection_method: options.billingPlanId
      ? 'cli_flag'
      : 'server_default',
  });

  // 7. Provision resource
  telemetry.trackCheckoutProvisioningStarted(marketplaceProps);
  output.spinner('Provisioning resource...');
  let result: AutoProvisionResult;
  try {
    result = await autoProvisionResource(
      client,
      integration.slug,
      product.slug,
      resourceName,
      metadata,
      acceptedPolicies,
      options.billingPlanId
    );
  } catch (error) {
    output.stopSpinner();
    telemetry.trackCheckoutProvisioningFailed(marketplaceProps);
    output.error((error as Error).message);
    return 1;
  }
  output.stopSpinner();
  output.debug(`Auto-provision result: ${JSON.stringify(result, null, 2)}`);

  // 8. Handle non-provisioned responses (metadata, unknown)
  if (result.kind !== 'provisioned') {
    telemetry.trackInstallFlowWebFallback({
      ...marketplaceProps,
      reason:
        result.kind === 'metadata'
          ? 'metadata_required'
          : (result.reason ?? 'server_fallback'),
      auto_provision_result_kind: result.kind,
      auto_provision_result_reason: result.reason,
    });
    output.debug(`Fallback required - kind: ${result.kind}`);
    output.debug(`Fallback URL from API: ${result.url}`);

    // Auto-detect project for browser URL
    const projectLink = await getLinkedProjectField(
      client,
      options.noConnect,
      'name'
    );
    if (projectLink.exitCode !== undefined) {
      return projectLink.exitCode;
    }

    output.log('Additional setup required. Opening browser...');
    const url = new URL(result.url);
    url.searchParams.set('defaultResourceName', resourceName);
    url.searchParams.set('source', 'cli');
    if (Object.keys(metadata).length > 0) {
      url.searchParams.set('metadata', JSON.stringify(metadata));
    }
    if (projectLink.value) {
      url.searchParams.set('projectSlug', projectLink.value);
    }
    if (options.billingPlanId) {
      url.searchParams.set('planId', options.billingPlanId);
    }
    output.debug(`Opening URL: ${url.href}`);
    open(url.href).catch((err: unknown) =>
      output.debug(`Failed to open browser: ${err}`)
    );
    return 1;
  }

  // 9. Success!
  if (result.kind !== 'provisioned') {
    // Unreachable — all non-provisioned kinds are handled above.
    // Guard exists so TypeScript narrows `result` without a type assertion.
    return 1;
  }
  const provisioned = result;
  telemetry.trackCheckoutProvisioningCompleted({
    ...marketplaceProps,
    resource_id: provisioned.resource.id,
    resource_name: resourceName,
  });
  output.debug(
    `Provisioned resource: ${JSON.stringify(provisioned.resource, null, 2)}`
  );
  output.debug(
    `Installation: ${JSON.stringify(provisioned.installation, null, 2)}`
  );
  output.debug(
    `Billing plan: ${JSON.stringify(provisioned.billingPlan, null, 2)}`
  );
  output.success(
    `${product.name} successfully provisioned: ${chalk.bold(resourceName)}`
  );

  // 9. Post-provision: dashboard URL, connect, env pull
  return postProvisionSetup(
    client,
    resourceName,
    provisioned.resource.id,
    contextName,
    {
      ...options,
      onProjectConnected: (projectId: string) => {
        telemetry.trackProjectConnected({
          ...marketplaceProps,
          project_id: projectId,
          resource_id: provisioned.resource.id,
        });
      },
    }
  );
}
