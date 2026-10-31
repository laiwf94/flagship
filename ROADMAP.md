# flagship: one-year roadmap (November 2026 to October 2027)

## Vision

By October 2027 flagship is a self-hosted, enterprise-grade feature management and experimentation platform that closes the main gaps to LaunchDarkly, Harness FME (Split), Optimizely, Statsig, ConfigCat, Unleash, Flagsmith and GrowthBook: change requests, release pipelines and guarded rollouts; warehouse-native experiments with sequential, CUPED and Bayesian analysis, layers and holdouts; SAML and OIDC single sign-on, SCIM, custom roles, tenants, encryption at rest and a tamper-evident audit stream; multi-region failover, point-in-time recovery and zero-downtime upgrades; and SDKs for Node, browsers, React, edge runtimes, Go, Python, Java, .NET, iOS and Android that all pass one test harness. Where a small project can win, it wins measurably: a single static relay binary in an image under 15 MB that idles under 20 MiB and serves more evaluations per vCPU than the leading self-hosted relays, with the benchmark published, re-run every quarter and enforced as a CI regression gate.

Benchmark products: LaunchDarkly, Harness FME (Split), Optimizely, Statsig, ConfigCat, Unleash, Flagsmith and GrowthBook. Rows such as A1 or G1 refer to the internal comparison matrix. Weeks 1 to 12 deliver the twelve v1 monthly themes, one per week; weeks 13 to 52 close the ranked gaps and the footprint targets.

## 2026-11 · Safe changes, experiments and automation

The first five v1 themes, one per week: multi-instance correctness, safe changes, experiments, automation and developer workflow.

| Week | Dates                    | Deliverable                      | Why                                                                                                                                                                                                                                                                |
| ---- | ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 2026-11-02 to 2026-11-08 | Correctness under many instances | Closes the known multi-instance gaps before anything is built on them (comparison rows E1, E4): today the sign-in budget multiplies per instance, cross-environment edits conflict falsely, a bad sync goes unnoticed and there is no backup or measured recovery. |
| 2    | 2026-11-09 to 2026-11-15 | Safe changes                     | Production edits must be reviewable and reversible, the baseline every leader sells (comparison rows A1, A5, A6): approvals on protected environments, reasons, searchable history, one-step rollback and stale flag detection.                                    |
| 3    | 2026-11-16 to 2026-11-22 | Experiments                      | Rollouts become measured experiments (comparison rows A3, B1, B7): progressive rollouts that step themselves, conversion events, per-variant results with intervals and a sample ratio check.                                                                      |
| 4    | 2026-11-23 to 2026-11-29 | Automation and integrations      | Other systems need to hear about and drive flag changes, and rollouts should stop themselves on bad metrics (comparison rows A3, F3): signed webhooks with a delivery log, scoped tokens and metric-guarded rollouts.                                              |
| 5    | 2026-11-30 to 2026-12-06 | Developer workflow               | Engineers want flags in their terminal, pull requests and compiler (comparison rows F2, F6): an OpenAPI contract, a CLI, flags as code with plan and apply, code references and typed keys.                                                                        |

## 2026-12 · SDKs, scale, operability and identity

The next four v1 themes, one per week: more SDKs, scale with a relay, operability, and identity and access.

| Week | Dates                    | Deliverable         | Why                                                                                                                                                                                                   |
| ---- | ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | 2026-12-07 to 2026-12-13 | More SDKs           | One evaluator in more runtimes (comparison rows C1, C3): a web-standard edge SDK, React bindings with server rendering, and a Go server SDK with streaming, all passing the conformance cases.        |
| 7    | 2026-12-14 to 2026-12-20 | Scale               | One LISTEN per instance and full snapshots on every reconnect cap how far flagship goes (comparison row C4): immutable compressed snapshots, a relay with offline mode and a 50,000-stream benchmark. |
| 8    | 2026-12-21 to 2026-12-27 | Operability         | Operators need to see where time goes and which apps are stale (comparison rows E6, G2): request tracing and histograms, connected SDK health, dashboards and alert rules, and retention.             |
| 9    | 2026-12-28 to 2027-01-03 | Identity and access | Sign-in and permissions must fit a company (comparison rows D2, D4, D7): OIDC single sign-on, per-project roles, environment write restrictions and a tamper-evident audit log.                       |

## 2027-01 · Targeting, console, first release and the benchmark

The last three v1 themes (targeting power, admin UI depth, release and ecosystem), then a reproducible benchmark against the leading relays with a CI regression gate.

| Week | Dates                    | Deliverable                                      | Why                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10   | 2027-01-04 to 2027-01-10 | Targeting power                                  | Real products target several entities, large lists, dates and structured config (comparison rows C6, C7, C8): date operators, multi-kind contexts, large segments and JSON variant schemas.                                                                                               |
| 11   | 2027-01-11 to 2027-01-17 | Admin UI depth                                   | The console has to be fast for people managing hundreds of flags (comparison rows B6, A4): mutually exclusive layers, a command palette, a prerequisite graph, environment compare and copy, and exposure trends.                                                                         |
| 12   | 2027-01-18 to 2027-01-24 | Release and ecosystem                            | Users need installable packages and standard formats (comparison rows C5, E5): published SDK packages, Kubernetes manifests, flagd import and export, and a 0.5 release with a benchmark and hardening report.                                                                            |
| 13   | 2027-01-25 to 2027-01-31 | Benchmark against the leading self-hosted relays | Comparison rows G1 and G2: the leaders publish footprint numbers (Unleash Edge lists about 7 MiB and 6,900 requests per second per vCPU), and flagship has none. A reproducible head-to-head with explicit targets makes the lightweight claim measurable and guards it from regressions. |

## 2027-02 · Lightweight relay and enterprise tenancy

A static-binary relay that beats the leaders on footprint, then tenants, SAML single sign-on and SCIM provisioning.

| Week | Dates                    | Deliverable                          | Why                                                                                                                                                                                                                                                           |
| ---- | ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14   | 2027-02-01 to 2027-02-07 | Static-binary relay                  | Comparison rows C4 and G1: every leader ships a self-hosted relay, and the lightest one is a Rust binary. Rebuilding the relay on the Go SDK as one static binary meets the footprint targets set last week and gives operators a sidecar they barely notice. |
| 15   | 2027-02-08 to 2027-02-14 | Organizations and tenant isolation   | Comparison row D6: the hosted leaders are multi-tenant by design; a self-hosted install serving several teams or customers needs organizations with enforced isolation, which every later enterprise week depends on.                                         |
| 16   | 2027-02-15 to 2027-02-21 | SAML 2.0 single sign-on              | Comparison row D1: LaunchDarkly, ConfigCat, Unleash and Flagsmith all sell SAML, and many identity teams still require it. A strict, dependency-free SAML service provider completes single sign-on next to OIDC.                                             |
| 17   | 2027-02-22 to 2027-02-28 | SCIM 2.0 provisioning with team sync | Comparison row D3: LaunchDarkly, Unleash, ConfigCat and GrowthBook provision users through SCIM so access ends when someone leaves. flagship has to as well, with groups synced to teams.                                                                     |

## 2027-03 · Enterprise access and release pipelines

Teams and custom role policies, passkeys and MFA, envelope encryption at rest, release pipelines across environments and notification channels.

| Week | Dates                    | Deliverable                                  | Why                                                                                                                                                                                                              |
| ---- | ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18   | 2027-03-01 to 2027-03-07 | Teams and custom role policies               | Comparison row D4: LaunchDarkly custom roles and Unleash custom project roles let organizations write their own permission policies. flagship's fixed roles need to become policies over resources and actions.  |
| 19   | 2027-03-08 to 2027-03-14 | Passkeys and MFA                             | Comparison row D5: installs without single sign-on rely on passwords. Passkeys and TOTP give phishing-resistant sign-in and a second factor that organizations can require.                                      |
| 20   | 2027-03-15 to 2027-03-21 | Envelope encryption at rest and key rotation | Comparison row E3: enterprises expect secrets and sensitive data encrypted with keys they control. Envelope encryption with pluggable key providers covers webhook secrets, SSO settings and private attributes. |
| 21   | 2027-03-22 to 2027-03-28 | Release pipelines across environments        | Comparison row A4: LaunchDarkly release pipelines move a flag through environments in phases with checks. This replaces ad hoc copying with a defined path from development to production.                       |
| 22   | 2027-03-29 to 2027-04-04 | Notification channels and inbox              | Comparison row F4: people need to hear about approvals waiting for them, guard breaches and pipeline holds without watching the UI.                                                                              |

## 2027-04 · Experimentation platform

A metric catalog, warehouse-native analysis, sequential testing with CUPED and corrections, and Bayesian analysis with bandits.

| Week | Dates                    | Deliverable                               | Why                                                                                                                                                                                                                  |
| ---- | ------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23   | 2027-04-05 to 2027-04-11 | Metric catalog                            | Comparison row B1: Statsig, GrowthBook, LaunchDarkly and Optimizely let teams define reusable metrics. flagship's conversions need to grow into a catalog of typed metrics.                                          |
| 24   | 2027-04-12 to 2027-04-18 | Warehouse-native experimentation          | Comparison row B2: Statsig and GrowthBook compute results from the customer's own warehouse. Teams with data in Postgres, ClickHouse, BigQuery or Snowflake should analyse experiments there without copying events. |
| 25   | 2027-04-19 to 2027-04-25 | Sequential testing, CUPED and corrections | Comparison rows B3 and B4: Optimizely, Statsig and GrowthBook offer sequential testing and variance reduction. Teams peek daily, and CUPED shortens experiments.                                                     |
| 26   | 2027-04-26 to 2027-05-02 | Bayesian analysis and bandits             | Comparison row B5: LaunchDarkly, GrowthBook, Statsig and Optimizely offer Bayesian results and multi-armed bandits. Product teams often want chance to win and automatic traffic shifting.                           |

## 2027-05 · Experiment programs and the SDK family

Holdouts and experiment programs, the Q2 server footprint re-measure, a language-neutral SDK harness, and Python and Java SDKs.

| Week | Dates                    | Deliverable                           | Why                                                                                                                                                                          |
| ---- | ------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 27   | 2027-05-03 to 2027-05-09 | Holdouts and experiment programs      | Comparison row B6: Statsig and LaunchDarkly measure the combined effect of everything shipped with holdouts and manage experiments as a program. flagship needs both.        |
| 28   | 2027-05-10 to 2027-05-16 | Server footprint diet (Q2 re-measure) | Comparison row G2: the server is a Node app in a distroless image. Cutting image size, memory and cold start keeps self-hosting cheap, and this is the quarterly re-measure. |
| 29   | 2027-05-17 to 2027-05-23 | Language-neutral SDK test harness     | Comparison row C1: leaders ship 15 to 25 SDKs. Shipping more SDKs safely needs a harness that drives any SDK through the same streaming, fallback and event scenarios.       |
| 30   | 2027-05-24 to 2027-05-30 | Python SDK                            | Comparison row C1: Python covers backend and data teams. A standard-library-only SDK keeps installs small.                                                                   |
| 31   | 2027-05-31 to 2027-06-06 | Java SDK                              | Comparison row C1: JVM services are a large share of enterprise backends. A JDK-only SDK brings flagship to them.                                                            |

## 2027-06 · Mobile, .NET and multi-region

iOS, Android and .NET SDKs, and regional read replicas with tested failover.

| Week | Dates                    | Deliverable                         | Why                                                                                                                                                         |
| ---- | ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32   | 2027-06-07 to 2027-06-13 | iOS SDK                             | Comparison row C2: every leader ships mobile SDKs. A Swift SDK with offline cache brings flagship to iOS apps.                                              |
| 33   | 2027-06-14 to 2027-06-20 | Android SDK                         | Comparison row C2: Android completes mobile coverage.                                                                                                       |
| 34   | 2027-06-21 to 2027-06-27 | .NET SDK                            | Comparison row C1: .NET is common in enterprise backends and supported by every leader.                                                                     |
| 35   | 2027-06-28 to 2027-07-04 | Regional read replicas and failover | Comparison row E2: the hosted leaders serve from many regions. Self-hosted operators need read-only regions fed by Postgres replicas and a tested failover. |

## 2027-07 · High availability and compliance

Zero-downtime upgrades, point-in-time recovery, audit streaming with compliance evidence, and privacy controls.

| Week | Dates                    | Deliverable                                  | Why                                                                                                                                                    |
| ---- | ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 36   | 2027-07-05 to 2027-07-11 | Zero-downtime upgrades and online migrations | Comparison row E1: enterprises upgrade without maintenance windows. Expand and contract migrations and rolling upgrade tests make that a guarantee.    |
| 37   | 2027-07-12 to 2027-07-18 | Point-in-time recovery and disaster recovery | Comparison row E4: hosted products hide backups; self-hosted operators need point-in-time recovery and drills that prove restores work.                |
| 38   | 2027-07-19 to 2027-07-25 | Audit streaming and compliance evidence      | Comparison row D8: enterprises send audit events to their SIEM and need evidence for audits. Streaming plus generated evidence packs cover both.       |
| 39   | 2027-07-26 to 2027-08-01 | Privacy controls                             | Comparison row D9: leaders offer private attributes and data deletion. flagship must let organizations keep personal data out and erase it on request. |

## 2027-08 · Fast engine and release insight

A compiled evaluation engine (Q3 re-measure), experiment and insight consoles, release monitoring per variant, and a targeting debugger.

| Week | Dates                    | Deliverable                                | Why                                                                                                                                                                                                     |
| ---- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40   | 2027-08-02 to 2027-08-08 | Compiled evaluation engine (Q3 re-measure) | Comparison row G1: evaluation speed is where a small project can lead. Compiling rulesets into closures and precomputed indexes cuts evaluation time, and this is the Q3 re-measure.                    |
| 41   | 2027-08-09 to 2027-08-15 | Experiment results console                 | Comparison rows B3 to B7: the statistics engines from April and May need a page people trust at a glance, as the leaders' results pages are what teams actually read.                                   |
| 42   | 2027-08-16 to 2027-08-22 | Release monitoring per variant             | Comparison row E7: Harness FME and LaunchDarkly attribute errors and latency to the variant a request was served. flagship can take the same signals from OpenTelemetry instead of a proprietary agent. |
| 43   | 2027-08-23 to 2027-08-29 | Insights dashboard                         | Comparison row A6: LaunchDarkly and Unleash show flag health and lifecycle insights. Platform owners need change frequency, stale flags and rollout progress in one place.                              |
| 44   | 2027-08-30 to 2027-09-05 | Context explorer and targeting debugger    | Comparison row C7: LaunchDarkly lets teams find a context and see every flag's value and why. Support and on-call engineers need the same to answer 'why does this user see this'.                      |

## 2027-09 · Integrations and ecosystem

Chat and issue tracker integrations, a Terraform provider, OpenFeature remote evaluation and importers from other flag services.

| Week | Dates                    | Deliverable                                | Why                                                                                                                                                                                                                                                    |
| ---- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 45   | 2027-09-06 to 2027-09-12 | Chat and issue tracker integrations        | Comparison row F4: the leaders approve changes from chat and link flags to issues. Reviewers act faster when the request reaches them where they already work.                                                                                         |
| 46   | 2027-09-13 to 2027-09-19 | Terraform provider                         | Comparison row F1: LaunchDarkly, Flagsmith, Unleash and ConfigCat publish Terraform providers. The provider uses hashicorp/terraform-plugin-framework, the one new dependency, because reimplementing the Terraform plugin protocol is not reasonable. |
| 47   | 2027-09-20 to 2027-09-26 | OpenFeature remote evaluation and tracking | Comparison row C5: ConfigCat serves OFREP through its proxy, and OpenFeature now defines a tracking API. Supporting both lets any OpenFeature SDK in any language use flagship without a native SDK.                                                   |
| 48   | 2027-09-27 to 2027-10-03 | Importers from other flag services         | Comparison row F5: most teams adopting flagship already use LaunchDarkly, Unleash, Flagsmith or ConfigCat. A one-command migration with equivalence checks removes the rewrite.                                                                        |

## 2027-10 · 1.0

A Kubernetes operator, fuzzing and hardening, one documentation site, and 1.0 with the Q4 re-measure and a year-one report.

| Week | Dates                    | Deliverable                    | Why                                                                                                                                                                         |
| ---- | ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 49   | 2027-10-04 to 2027-10-10 | Kubernetes operator            | Comparison row E5: Unleash and Flagsmith ship Helm charts; Kubernetes-native teams also want flags as custom resources reconciled by GitOps tools.                          |
| 50   | 2027-10-11 to 2027-10-17 | Fuzzing and security hardening | Comparison row D7: an enterprise buyer's review starts at the parsers and boundaries. Coverage-guided fuzzing and a written threat model find problems first.               |
| 51   | 2027-10-18 to 2027-10-24 | Documentation site             | Comparison row F2: the leaders all have searchable docs. README and DESIGN have outgrown one page. This is the year's one docs week.                                        |
| 52   | 2027-10-25 to 2027-10-31 | 1.0 with the Q4 re-measure     | Comparison rows G1 and G2: 1.0 is a promise backed by numbers. The API freezes, upgrades are proven from every 0.x schema, and the benchmark is re-run against the leaders. |

## Next year

Gaps from the comparison that stay open after October 2027:

- Hosted multi-tenant offering with a managed control plane (all hosted leaders).
- Visual editor for web experiments without code (Optimizely Web, GrowthBook visual editor).
- Product analytics and session replay next to experiments (Statsig, LaunchDarkly observability).
- AI configuration management for prompts and model parameters (LaunchDarkly AI Configs).
- More SDKs: PHP, Ruby, Rust, Elixir, Flutter and React Native (the leaders ship 15 to 25).
- More warehouse connectors (Databricks and others) and contextual bandits.
- Formal compliance certifications and an external penetration test, which need an organization behind the project.
