export interface DataLayerEntrySummary {
	event?: string;
	keys: string[];
	preview: string;
}

export interface AnalyticsSnapshot {
	pageUrl: string;
	pageTitle: string;
	scriptUrls: string[];
	iframeUrls: string[];
	imageUrls: string[];
	requestUrls: string[];
	globalNames: string[];
	gtmContainers: string[];
	inlineScriptText: string;
	dataLayerPresent: boolean;
	dataLayerLength: number;
	dataLayerEntries: DataLayerEntrySummary[];
}

export interface TagDetection {
	vendor: string;
	description: string;
	ids: string[];
	signals: string[];
	matchedUrls: string[];
}

export interface AnalyticsInspectionDetails {
	pageUrl: string;
	pageTitle: string;
	tags: TagDetection[];
	dataLayerPresent: boolean;
	dataLayerLength: number;
	dataLayerEntries: DataLayerEntrySummary[];
	matchedRequestUrls: string[];
}

interface VendorDefinition {
	vendor: string;
	description: string;
	patterns: RegExp[];
	globalNames?: string[];
	idPatterns: RegExp[];
}

const MAX_MATCHED_URLS = 5;

const VENDORS: VendorDefinition[] = [
	{
		vendor: "Google Tag Manager",
		description: "Detects GTM containers, scripts, and runtime objects.",
		patterns: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]+/g],
		globalNames: ["google_tag_manager", "dataLayer"],
		idPatterns: [/GTM-[A-Z0-9]+/g],
	},
	{
		vendor: "Google Analytics",
		description: "Detects GA4 or gtag-based Google Analytics instrumentation.",
		patterns: [/googletagmanager\.com\/gtag\/js/i, /google-analytics\.com/i, /G-[A-Z0-9]+/g, /UA-\d+-\d+/g],
		globalNames: ["gtag", "ga", "dataLayer"],
		idPatterns: [/G-[A-Z0-9]+/g, /UA-\d+-\d+/g],
	},
	{
		vendor: "Google Ads / Floodlight",
		description: "Detects Google Ads and Floodlight marketing tags.",
		patterns: [/doubleclick\.net/i, /googleadservices\.com/i, /AW-\d+/g, /DC-\d+/g],
		globalNames: ["gtag", "dataLayer"],
		idPatterns: [/AW-\d+/g, /DC-\d+/g],
	},
	{
		vendor: "Meta Pixel",
		description: "Detects Facebook or Meta Pixel scripts and runtime globals.",
		patterns: [/connect\.facebook\.net\/.*fbevents\.js/i, /facebook\.com\/tr/i],
		globalNames: ["fbq", "_fbq"],
		idPatterns: [/\b\d{8,16}\b/g],
	},
	{
		vendor: "TikTok Pixel",
		description: "Detects TikTok marketing pixel scripts and globals.",
		patterns: [/analytics\.tiktok\.com/i, /tiktok/i],
		globalNames: ["ttq"],
		idPatterns: [/\b[A-Z0-9]{8,}\b/g],
	},
	{
		vendor: "LinkedIn Insight",
		description: "Detects LinkedIn Insight Tag scripts and globals.",
		patterns: [/snap\.licdn\.com\/li\.lms-analytics/i, /px\.ads\.linkedin\.com/i],
		globalNames: ["lintrk", "_linkedin_data_partner_ids"],
		idPatterns: [/\b\d{6,}\b/g],
	},
	{
		vendor: "Pinterest Tag",
		description: "Detects Pinterest tag scripts and runtime globals.",
		patterns: [/s\.pinimg\.com\/ct\/core\.js/i, /ct\.pinterest\.com/i],
		globalNames: ["pintrk"],
		idPatterns: [/\b\d{6,}\b/g],
	},
	{
		vendor: "X Ads Pixel",
		description: "Detects X or Twitter conversion tracking tags.",
		patterns: [/static\.ads-twitter\.com\/uwt\.js/i, /analytics\.twitter\.com\/i\/adsct/i, /t\.co\/i\/adsct/i],
		globalNames: ["twq"],
		idPatterns: [/\b[A-Z0-9]{6,}\b/g],
	},
	{
		vendor: "Reddit Pixel",
		description: "Detects Reddit marketing pixel requests and globals.",
		patterns: [/redditmedia\.com\/events/i, /events\.redditmedia\.com/i],
		globalNames: ["rdt"],
		idPatterns: [/\b[a-z0-9]{6,}\b/gi],
	},
	{
		vendor: "Segment",
		description: "Detects Segment analytics.js or Segment runtime globals.",
		patterns: [/cdn\.segment\.com\/analytics\.js/i, /segment\.com/i],
		globalNames: ["analytics"],
		idPatterns: [/\b[A-Z0-9]{6,}\b/g],
	},
	{
		vendor: "RudderStack",
		description: "Detects RudderStack scripts and runtime globals.",
		patterns: [/rudderlabs\.com/i],
		globalNames: ["rudderanalytics"],
		idPatterns: [/\b[A-Z0-9]{6,}\b/g],
	},
	{
		vendor: "Adobe Experience Platform",
		description: "Detects Adobe Launch, Adobe Analytics, or Experience Platform signals.",
		patterns: [/assets\.adobedtm\.com/i, /omtrdc\.net/i],
		globalNames: ["_satellite", "adobeDataLayer"],
		idPatterns: [/\b[A-Z0-9]{6,}\b/g],
	},
	{
		vendor: "Tealium",
		description: "Detects Tealium tags and runtime globals.",
		patterns: [/tags\.tiqcdn\.com/i],
		globalNames: ["utag"],
		idPatterns: [/\b[A-Z0-9]{6,}\b/g],
	},
];

function unique<T>(items: Iterable<T>): T[] {
	return Array.from(new Set(items));
}

function collectMatchedUrls(snapshot: AnalyticsSnapshot, patterns: RegExp[]): string[] {
	const urls = [...snapshot.scriptUrls, ...snapshot.iframeUrls, ...snapshot.imageUrls, ...snapshot.requestUrls];
	return unique(urls.filter((url) => patterns.some((pattern) => new RegExp(pattern).test(url)))).slice(
		0,
		MAX_MATCHED_URLS,
	);
}

function collectSignals(snapshot: AnalyticsSnapshot, vendor: VendorDefinition, matchedUrls: string[]): string[] {
	const signals: string[] = [];

	if (matchedUrls.length > 0) {
		signals.push(`${matchedUrls.length} matched resource${matchedUrls.length === 1 ? "" : "s"}`);
	}

	const globals = vendor.globalNames?.filter((name) => snapshot.globalNames.includes(name)) ?? [];
	for (const globalName of globals) {
		signals.push(`global: ${globalName}`);
	}

	if (vendor.vendor === "Google Tag Manager" && snapshot.gtmContainers.length > 0) {
		signals.push(`containers: ${snapshot.gtmContainers.join(", ")}`);
	}

	if ((vendor.vendor === "Google Tag Manager" || vendor.vendor === "Google Analytics") && snapshot.dataLayerPresent) {
		signals.push(`dataLayer entries: ${snapshot.dataLayerLength}`);
	}

	return unique(signals);
}

function extractIds(snapshot: AnalyticsSnapshot, vendor: VendorDefinition): string[] {
	const haystack = [
		snapshot.pageUrl,
		...snapshot.scriptUrls,
		...snapshot.iframeUrls,
		...snapshot.imageUrls,
		...snapshot.requestUrls,
		...snapshot.globalNames,
		...snapshot.gtmContainers,
		snapshot.inlineScriptText,
	]
		.join("\n")
		.slice(0, 250_000);

	const ids = new Set<string>();
	for (const pattern of vendor.idPatterns) {
		for (const match of haystack.matchAll(pattern)) {
			if (match[0]) {
				ids.add(match[0]);
			}
		}
	}
	return Array.from(ids).slice(0, 10);
}

function vendorDetected(snapshot: AnalyticsSnapshot, vendor: VendorDefinition): boolean {
	const urls = [...snapshot.scriptUrls, ...snapshot.iframeUrls, ...snapshot.imageUrls, ...snapshot.requestUrls];
	const textHaystack = `${snapshot.pageUrl}\n${snapshot.inlineScriptText}\n${snapshot.gtmContainers.join("\n")}`;

	const matchedUrl = urls.some((url) => vendor.patterns.some((pattern) => new RegExp(pattern).test(url)));
	const matchedText = vendor.patterns.some((pattern) => new RegExp(pattern).test(textHaystack));
	const matchedGlobal = vendor.globalNames?.some((globalName) => snapshot.globalNames.includes(globalName)) ?? false;

	return matchedUrl || matchedText || matchedGlobal;
}

export function buildAnalyticsInspection(snapshot: AnalyticsSnapshot): AnalyticsInspectionDetails {
	const tags = VENDORS.filter((vendor) => vendorDetected(snapshot, vendor))
		.map((vendor) => {
			const matchedUrls = collectMatchedUrls(snapshot, vendor.patterns);
			return {
				vendor: vendor.vendor,
				description: vendor.description,
				ids: extractIds(snapshot, vendor),
				signals: collectSignals(snapshot, vendor, matchedUrls),
				matchedUrls,
			} satisfies TagDetection;
		})
		.sort((a, b) => a.vendor.localeCompare(b.vendor));

	return {
		pageUrl: snapshot.pageUrl,
		pageTitle: snapshot.pageTitle,
		tags,
		dataLayerPresent: snapshot.dataLayerPresent,
		dataLayerLength: snapshot.dataLayerLength,
		dataLayerEntries: snapshot.dataLayerEntries,
		matchedRequestUrls: unique(snapshot.requestUrls).slice(0, 10),
	};
}
