import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsInspection, type AnalyticsSnapshot } from "../src/tools/analytics-inspector-core.js";

function createSnapshot(overrides: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
	return {
		pageUrl: "https://example.com/products",
		pageTitle: "Example Product",
		scriptUrls: [],
		iframeUrls: [],
		imageUrls: [],
		requestUrls: [],
		globalNames: [],
		gtmContainers: [],
		inlineScriptText: "",
		dataLayerPresent: false,
		dataLayerLength: 0,
		dataLayerEntries: [],
		...overrides,
	};
}

test("detects GTM, Meta Pixel, and dataLayer activity", () => {
	const details = buildAnalyticsInspection(
		createSnapshot({
			scriptUrls: [
				"https://www.googletagmanager.com/gtm.js?id=GTM-TEST123",
				"https://connect.facebook.net/en_US/fbevents.js",
			],
			requestUrls: ["https://www.facebook.com/tr?id=1234567890&ev=PageView"],
			globalNames: ["dataLayer", "google_tag_manager", "fbq"],
			gtmContainers: ["GTM-TEST123"],
			inlineScriptText: "fbq('init', '1234567890');",
			dataLayerPresent: true,
			dataLayerLength: 2,
			dataLayerEntries: [
				{ event: "page_view", keys: ["event", "page_type"], preview: "event: page_view, page_type: product" },
				{ event: "view_item", keys: ["event", "item_id"], preview: "event: view_item, item_id: sku-42" },
			],
		}),
	);

	assert.equal(details.dataLayerPresent, true);
	assert.equal(details.dataLayerLength, 2);
	assert.ok(details.tags.some((tag) => tag.vendor === "Google Tag Manager"));
	assert.ok(details.tags.some((tag) => tag.vendor === "Meta Pixel"));

	const gtm = details.tags.find((tag) => tag.vendor === "Google Tag Manager");
	assert.deepEqual(gtm?.ids, ["GTM-TEST123"]);
});

test("detects price-filtered analytics resources and dataLayer summaries", () => {
	const details = buildAnalyticsInspection(
		createSnapshot({
			pageUrl: "https://shop.example.com/cart",
			scriptUrls: [
				"https://www.googletagmanager.com/gtag/js?id=G-TEST987",
				"https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=TT123456",
				"https://snap.licdn.com/li.lms-analytics/insight.min.js",
			],
			requestUrls: [
				"https://analytics.google.com/g/collect?v=2&tid=G-TEST987",
				"https://analytics.tiktok.com/api/v2/pixel",
				"https://px.ads.linkedin.com/collect",
			],
			globalNames: ["gtag", "ttq", "lintrk", "dataLayer"],
			inlineScriptText:
				"window.dataLayer = window.dataLayer || []; gtag('config', 'G-TEST987'); _linkedin_data_partner_ids.push('987654');",
			dataLayerPresent: true,
			dataLayerLength: 3,
			dataLayerEntries: [
				{ event: "page_view", keys: ["event"], preview: "event: page_view" },
				{ event: "add_to_cart", keys: ["event", "currency"], preview: "event: add_to_cart, currency: GBP" },
				{ event: "purchase", keys: ["event", "value"], preview: "event: purchase, value: 149.99" },
			],
		}),
	);

	assert.ok(details.tags.some((tag) => tag.vendor === "Google Analytics"));
	assert.ok(details.tags.some((tag) => tag.vendor === "TikTok Pixel"));
	assert.ok(details.tags.some((tag) => tag.vendor === "LinkedIn Insight"));
	assert.equal(details.dataLayerEntries.at(-1)?.event, "purchase");
});
