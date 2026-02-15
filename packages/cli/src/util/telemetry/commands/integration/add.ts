import { TelemetryClient } from '../..';
import type { TelemetryMethods } from '../../types';
import type { addSubcommand } from '../../../../commands/integration/command';

export interface MarketplaceEventProperties {
  integration_id: string;
  integration_slug: string;
  integration_name: string;
  product_id: string;
  product_slug: string;
  is_from_cli: true;
  is_cli_auto_provision: boolean;
}

export interface PlanSelectedProperties extends MarketplaceEventProperties {
  billing_plan_id?: string;
  plan_selection_method: 'cli_flag' | 'interactive' | 'server_default';
}

export interface ProvisioningCompletedProperties
  extends MarketplaceEventProperties {
  resource_id: string;
  resource_name: string;
}

export interface ProjectConnectedProperties extends MarketplaceEventProperties {
  project_id: string;
  resource_id: string;
}

export type ProvisioningFailedProperties = MarketplaceEventProperties;

export interface WebFallbackProperties extends MarketplaceEventProperties {
  reason: // Legacy path reasons
  | 'unsupported_wizard'
    | 'non_subscription_plan'
    // Shared
    | 'metadata_required'
    | 'policy_declined'
    // Auto-provision: API-provided reasons (from result.reason)
    | 'installation_only'
    | 'no_eligible_plan'
    | 'preauthorization_required'
    | 'payment_method_required'
    | 'error'
    // Auto-provision: fallback when API doesn't provide a reason
    | 'server_fallback';
  // For non_subscription_plan: what plan type/id forced the fallback
  billing_plan_id?: string;
  billing_plan_type?: string;
  // For auto-provision fallbacks: the raw result.kind from the API response
  auto_provision_result_kind?: string;
  // For auto-provision fallbacks: the raw result.reason from the API response
  auto_provision_result_reason?: string;
}

export class IntegrationAddTelemetryClient
  extends TelemetryClient
  implements TelemetryMethods<typeof addSubcommand>
{
  trackCliArgumentIntegration(v: string | undefined, known?: boolean) {
    if (v) {
      this.trackCliArgument({
        arg: 'integration',
        value: known ? v : this.redactedValue,
      });
    }
  }

  trackCliOptionName(v: string | undefined) {
    if (v) {
      this.trackCliOption({
        option: 'name',
        value: this.redactedValue,
      });
    }
  }

  trackCliOptionMetadata(v: string[] | undefined) {
    if (v?.length) {
      this.trackCliOption({
        option: 'metadata',
        value: this.redactedValue,
      });
    }
  }

  trackCliOptionPlan(v: string | undefined) {
    if (v) {
      this.trackCliOption({
        option: 'plan',
        value: this.redactedValue,
      });
    }
  }

  trackCliFlagNoConnect(v: boolean | undefined) {
    if (v) {
      this.trackCliFlag('no-connect');
    }
  }

  trackCliFlagNoEnvPull(v: boolean | undefined) {
    if (v) {
      this.trackCliFlag('no-env-pull');
    }
  }

  trackCliOptionEnvironment(v: string[] | undefined) {
    if (v?.length) {
      this.trackCliOption({
        option: 'environment',
        value: this.redactedValue,
      });
    }
  }

  trackInstallFlowStarted(props: MarketplaceEventProperties) {
    this.trackMarketplaceEvent('marketplace_install_flow_started', props);
  }

  trackCheckoutPlanSelected(props: PlanSelectedProperties) {
    this.trackMarketplaceEvent('marketplace_checkout_plan_selected', props);
  }

  trackCheckoutProvisioningStarted(props: MarketplaceEventProperties) {
    this.trackMarketplaceEvent(
      'marketplace_checkout_provisioning_started',
      props
    );
  }

  trackCheckoutProvisioningCompleted(props: ProvisioningCompletedProperties) {
    this.trackMarketplaceEvent(
      'marketplace_checkout_provisioning_completed',
      props
    );
  }

  trackCheckoutProvisioningFailed(props: ProvisioningFailedProperties) {
    this.trackMarketplaceEvent(
      'marketplace_checkout_provisioning_failed',
      props
    );
  }

  trackProjectConnected(props: ProjectConnectedProperties) {
    this.trackMarketplaceEvent('marketplace_project_connected', props);
  }

  trackInstallFlowWebFallback(props: WebFallbackProperties) {
    this.trackMarketplaceEvent('marketplace_install_flow_web_fallback', props);
  }

  private trackMarketplaceEvent(
    eventName: string,
    props: MarketplaceEventProperties
  ) {
    this.trackCommandOutput({
      key: eventName,
      value: JSON.stringify(props),
    });
  }
}
