import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Search } from "lucide";
import type {
	AnalyticsInspectionDetails,
	AnalyticsSnapshot,
	DataLayerEntrySummary,
} from "./analytics-inspector-core.js";
import { buildAnalyticsInspection } from "./analytics-inspector-core.js";
import { findInspectableAnalyticsTarget } from "./analytics-inspector-target.js";

const analyticsInspectorSchema = Type.Object({
	maxEvents: Type.Optional(
		Type.Number({
			description: "Maximum number of recent dataLayer entries to include (default 8)",
			minimum: 1,
			maximum: 20,
		}),
	),
});

type AnalyticsInspectorParams = Static<typeof analyticsInspectorSchema>;
const ANALYTICS_PAYLOAD_PREFIX = "__sitegeist_analytics__";

function summarizeValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return `{${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""}}`;
	}
	return String(value);
}

function sanitizeEntry(entry: unknown): DataLayerEntrySummary {
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const record = entry as Record<string, unknown>;
		const keys = Object.keys(record).slice(0, 12);
		return {
			event: typeof record.event === "string" ? record.event : undefined,
			keys,
			preview: keys
				.slice(0, 4)
				.map((key) => `${key}: ${summarizeValue(record[key])}`)
				.join(", "),
		};
	}

	if (Array.isArray(entry)) {
		return {
			keys: [`array(${entry.length})`],
			preview: summarizeValue(entry),
		};
	}

	return {
		keys: [],
		preview: summarizeValue(entry),
	};
}

async function collectAnalyticsSnapshot(tabId: number, maxEvents: number): Promise<AnalyticsSnapshot> {
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (eventLimit: number) => {
			const collectUrls = (selector: string, attr: "src" | "href"): string[] =>
				Array.from(document.querySelectorAll(selector))
					.map((element) => element.getAttribute(attr) || "")
					.filter(Boolean);

			const scriptUrls = collectUrls("script[src]", "src");
			const iframeUrls = collectUrls("iframe[src]", "src");
			const imageUrls = collectUrls("img[src]", "src");
			const requestUrls = performance
				.getEntriesByType("resource")
				.map((entry) => entry.name)
				.filter(Boolean);

			const candidateGlobals = [
				"dataLayer",
				"gtag",
				"google_tag_manager",
				"ga",
				"fbq",
				"_fbq",
				"ttq",
				"lintrk",
				"_linkedin_data_partner_ids",
				"pintrk",
				"twq",
				"rdt",
				"analytics",
				"rudderanalytics",
				"_satellite",
				"adobeDataLayer",
				"utag",
			];

			const globalNames = candidateGlobals.filter((name) => {
				const scopedWindow = window as unknown as Record<string, unknown>;
				return typeof scopedWindow[name] !== "undefined";
			});

			const gtmContainers = (() => {
				const scopedWindow = window as unknown as Record<string, unknown>;
				const value = scopedWindow.google_tag_manager;
				if (!value || typeof value !== "object") return [];
				return Object.keys(value as Record<string, unknown>).filter((key) => key.startsWith("GTM-"));
			})();

			const inlineScriptText = Array.from(document.querySelectorAll("script:not([src])"))
				.map((script) => script.textContent || "")
				.join("\n")
				.slice(0, 50_000);

			const dataLayerValue = (() => {
				const scopedWindow = window as unknown as Record<string, unknown>;
				return scopedWindow.dataLayer;
			})();
			const dataLayer = Array.isArray(dataLayerValue) ? dataLayerValue : [];

			return {
				pageUrl: location.href,
				pageTitle: document.title,
				scriptUrls,
				iframeUrls,
				imageUrls,
				requestUrls,
				globalNames,
				gtmContainers,
				inlineScriptText,
				dataLayerPresent: Array.isArray(dataLayerValue),
				dataLayerLength: dataLayer.length,
				dataLayerEntries: dataLayer.slice(-eventLimit).map((entry) => {
					if (entry && typeof entry === "object" && !Array.isArray(entry)) {
						const record = entry as Record<string, unknown>;
						const keys = Object.keys(record).slice(0, 12);
						return {
							event: typeof record.event === "string" ? record.event : undefined,
							keys,
							preview: keys
								.slice(0, 4)
								.map((key) => `${key}: ${String(record[key])}`)
								.join(", "),
						};
					}
					if (Array.isArray(entry)) {
						return {
							keys: [`array(${entry.length})`],
							preview: `[${entry.length} items]`,
						};
					}
					return {
						keys: [],
						preview: String(entry),
					};
				}),
			};
		},
		args: [maxEvents],
	});

	if (!result) {
		throw new Error("Failed to collect analytics snapshot from the active tab");
	}

	return {
		...result,
		dataLayerEntries: (result.dataLayerEntries || []).map((entry) => sanitizeEntry(entry)),
	} satisfies AnalyticsSnapshot;
}

function normalizeAnalyticsDetails(
	value: AnalyticsInspectionDetails | undefined,
): AnalyticsInspectionDetails | undefined {
	if (!value || !Array.isArray(value.tags) || !Array.isArray(value.dataLayerEntries)) {
		return undefined;
	}

	return {
		pageTitle: value.pageTitle || "Untitled page",
		pageUrl: value.pageUrl || "",
		tags: value.tags,
		dataLayerPresent: Boolean(value.dataLayerPresent),
		dataLayerLength:
			typeof value.dataLayerLength === "number" ? value.dataLayerLength : value.dataLayerEntries.length,
		dataLayerEntries: value.dataLayerEntries,
		matchedRequestUrls: Array.isArray(value.matchedRequestUrls) ? value.matchedRequestUrls : [],
	};
}

function toTextSummary(details: AnalyticsInspectionDetails): string {
	const lines: string[] = [];
	lines.push(`Analytics inspection for ${details.pageTitle}`);
	lines.push(`Page: ${details.pageUrl}`);
	lines.push(`Detected tags: ${details.tags.length}`);
	lines.push(`dataLayer: ${details.dataLayerPresent ? `${details.dataLayerLength} entries` : "not detected"}`);

	if (details.tags.length > 0) {
		lines.push("");
		lines.push("Detected vendors:");
		for (const tag of details.tags) {
			lines.push(`- ${tag.vendor}${tag.ids.length > 0 ? ` (${tag.ids.join(", ")})` : ""}`);
		}
	}

	if (details.dataLayerEntries.length > 0) {
		lines.push("");
		lines.push("Recent dataLayer entries:");
		for (const entry of details.dataLayerEntries) {
			lines.push(`- ${entry.event || "eventless"}: ${entry.preview}`);
		}
	}

	return lines.join("\n");
}

export class AnalyticsInspectorTool implements AgentTool<typeof analyticsInspectorSchema, AnalyticsInspectionDetails> {
	name = "inspect_analytics";
	label = "Inspect Analytics";
	description = `Inspect the current page for dataLayer entries and common analytics or marketing tags.

Use this when the user wants:
- dataLayer events or payloads
- Google Tag Manager, GA4, Meta Pixel, TikTok, LinkedIn, Pinterest, Adobe, Segment, or similar tag detection
- a quick instrumentation audit similar to Analytics Debugger or Omnibug

Returns detected vendors, IDs where available, matched resources, and recent dataLayer entries.`;
	parameters = analyticsInspectorSchema;

	async execute(
		_toolCallId: string,
		args: AnalyticsInspectorParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<AnalyticsInspectionDetails>> {
		const maxEvents = args.maxEvents || 8;
		const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });
		const allTabs = await chrome.tabs.query({});
		const { snapshot } = await findInspectableAnalyticsTarget(currentWindowTabs, allTabs, (tabId) =>
			collectAnalyticsSnapshot(tabId, maxEvents),
		);
		const details = buildAnalyticsInspection(snapshot);

		return {
			content: [
				{ type: "text", text: toTextSummary(details) } satisfies TextContent,
				{ type: "text", text: `${ANALYTICS_PAYLOAD_PREFIX}${JSON.stringify(details)}` } satisfies TextContent,
			],
			details,
		};
	}
}

const analyticsInspectorRenderer: ToolRenderer<AnalyticsInspectorParams, AnalyticsInspectionDetails> = {
	render(
		_params: AnalyticsInspectorParams | undefined,
		result: ToolResultMessage<AnalyticsInspectionDetails> | undefined,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const payloadText = result?.content
			?.filter((content) => content.type === "text")
			.map((content) => content.text)
			.find((text) => text.startsWith(ANALYTICS_PAYLOAD_PREFIX));
		const details = normalizeAnalyticsDetails(
			result?.details ||
				(payloadText
					? (JSON.parse(payloadText.slice(ANALYTICS_PAYLOAD_PREFIX.length)) as AnalyticsInspectionDetails)
					: undefined),
		);
		const summaryText = result?.content
			?.filter((content) => content.type === "text")
			.map((content) => content.text)
			.find((text) => !text.startsWith(ANALYTICS_PAYLOAD_PREFIX));

		return {
			content: html`
				${renderHeader(state, Search, "Analytics Inspector")}
				${
					details
						? html`
							<div class="px-3 pb-3 space-y-3 text-xs">
								<div class="flex flex-wrap gap-2">
									<span class="px-2 py-1 rounded-full bg-secondary text-secondary-foreground">
										${details.tags.length} tag${details.tags.length === 1 ? "" : "s"}
									</span>
									<span class="px-2 py-1 rounded-full bg-secondary text-secondary-foreground">
										dataLayer: ${details.dataLayerPresent ? details.dataLayerLength : 0}
									</span>
								</div>

								<div class="rounded-lg border border-border p-3 space-y-1">
									<div class="font-medium">${details.pageTitle}</div>
									<div class="text-muted-foreground break-all">${details.pageUrl}</div>
								</div>

								<div class="space-y-2">
									<div class="font-medium">Detected Tags</div>
									${
										details.tags.length > 0
											? details.tags.map(
													(tag) => html`
														<div class="rounded-lg border border-border p-3 space-y-2">
															<div class="flex flex-wrap items-center gap-2">
																<span class="font-medium">${tag.vendor}</span>
																${tag.ids.map(
																	(id) =>
																		html`<span class="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">${id}</span>`,
																)}
															</div>
															<div class="text-muted-foreground">${tag.description}</div>
															${
																tag.signals.length > 0
																	? html`<ul class="list-disc pl-4 space-y-1">
																		${tag.signals.map((signal) => html`<li>${signal}</li>`)}
																	</ul>`
																	: ""
															}
															${
																tag.matchedUrls.length > 0
																	? html`<div class="space-y-1">
																		<div class="font-medium">Matched resources</div>
																		${tag.matchedUrls.map(
																			(url) =>
																				html`<div class="break-all text-muted-foreground">${url}</div>`,
																		)}
																	</div>`
																	: ""
															}
														</div>
													`,
												)
											: html`<div class="rounded-lg border border-border p-3 text-muted-foreground">
												No known analytics or marketing tags detected.
											</div>`
									}
								</div>

								<div class="space-y-2">
									<div class="font-medium">Recent dataLayer Entries</div>
									${
										details.dataLayerPresent
											? details.dataLayerEntries.length > 0
												? details.dataLayerEntries.map(
														(entry) => html`
															<div class="rounded-lg border border-border p-3 space-y-1">
																<div class="flex items-center gap-2">
																	<span class="font-medium">${entry.event || "eventless entry"}</span>
																	${entry.keys.map(
																		(key) =>
																			html`<span class="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">${key}</span>`,
																	)}
																</div>
																<div class="text-muted-foreground break-words">${entry.preview || "No preview available"}</div>
															</div>
														`,
													)
												: html`<div class="rounded-lg border border-border p-3 text-muted-foreground">
													dataLayer detected, but no entries were captured.
												</div>`
											: html`<div class="rounded-lg border border-border p-3 text-muted-foreground">
												dataLayer was not detected on this page.
											</div>`
									}
								</div>
							</div>
						`
						: summaryText
							? html`<div class="px-3 pb-3 text-xs">
								<markdown-block .content=${summaryText}></markdown-block>
							</div>`
							: ""
				}
			`,
			isCustom: false,
		};
	},
};

export function registerAnalyticsInspectorRenderer() {
	registerToolRenderer("inspect_analytics", analyticsInspectorRenderer);
}

registerAnalyticsInspectorRenderer();
