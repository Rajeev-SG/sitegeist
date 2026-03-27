import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs";

const ROOT = "/Users/rajeev/Code/sitegeist-src";
const DIST_DIR = path.join(ROOT, "dist-chrome");
const ARTIFACTS_ROOT = path.join(ROOT, "output", "playwright");

async function main() {
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const artifactDir = path.join(ARTIFACTS_ROOT, `analytics-ui-${timestamp}`);
	const profileDir = path.join(ARTIFACTS_ROOT, `analytics-ui-profile-${timestamp}`);
	await mkdir(artifactDir, { recursive: true });
	await rm(profileDir, { recursive: true, force: true });

	const context = await chromium.launchPersistentContext(profileDir, {
		headless: false,
		args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
	});

	try {
		let serviceWorker = context.serviceWorkers()[0];
		if (!serviceWorker) {
			serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
		}
		const extensionId = new URL(serviceWorker.url()).host;

		const page = await context.newPage();
		await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
		await page.waitForLoadState("networkidle");
		await page.evaluate(async () => {
			await customElements.whenDefined("tool-message");
		});

		const details = {
			pageTitle: "Analytics Fixture",
			pageUrl: "https://example.test/analytics-fixture",
			tags: [
				{
					vendor: "Google Tag Manager",
					description: "Detects GTM containers, scripts, and runtime objects.",
					ids: ["GTM-TEST123"],
					signals: ["1 matched resource", "global: google_tag_manager", "dataLayer entries: 3"],
					matchedUrls: ["https://www.googletagmanager.com/gtm.js?id=GTM-TEST123"],
				},
				{
					vendor: "LinkedIn Insight",
					description: "Detects LinkedIn Insight Tag scripts and globals.",
					ids: ["987654"],
					signals: ["1 matched resource", "global: lintrk"],
					matchedUrls: ["https://snap.licdn.com/li.lms-analytics/insight.min.js"],
				},
				{
					vendor: "Meta Pixel",
					description: "Detects Facebook or Meta Pixel scripts and runtime globals.",
					ids: ["123456789012345"],
					signals: ["2 matched resources", "global: fbq"],
					matchedUrls: [
						"https://connect.facebook.net/en_US/fbevents.js",
						"https://www.facebook.com/tr?id=123456789012345&ev=PageView",
					],
				},
				{
					vendor: "TikTok Pixel",
					description: "Detects TikTok marketing pixel scripts and globals.",
					ids: ["TIKTOK123"],
					signals: ["1 matched resource", "global: ttq"],
					matchedUrls: ["https://analytics.tiktok.com/i18n/pixel/events.js"],
				},
			],
			dataLayerPresent: true,
			dataLayerLength: 3,
			dataLayerEntries: [
				{ event: "page_view", keys: ["event", "page_type"], preview: "event: page_view, page_type: product" },
				{ event: "view_item", keys: ["event", "sku"], preview: "event: view_item, sku: COROLLA-001" },
				{ event: "add_to_cart", keys: ["event", "value"], preview: "event: add_to_cart, value: 14999" },
			],
			matchedRequestUrls: [
				"https://www.googletagmanager.com/gtm.js?id=GTM-TEST123",
				"https://connect.facebook.net/en_US/fbevents.js",
			],
		};

		await page.evaluate((proofDetails) => {
			const app = document.body.firstElementChild;
			if (app instanceof HTMLElement) {
				app.style.display = "none";
			}

			const root = document.createElement("div");
			root.className = "min-h-screen bg-background text-foreground p-6 space-y-4";
			root.innerHTML = '<div class="text-sm font-medium">Analytics Inspector UI Proof</div>';

			const successMessage = document.createElement("tool-message");
			successMessage.toolCall = {
				type: "toolCall",
				id: "call_success",
				name: "inspect_analytics",
				arguments: { maxEvents: 8 },
			};
			successMessage.result = {
				role: "toolResult",
				toolCallId: "call_success",
				toolName: "inspect_analytics",
				content: [
					{
						type: "text",
						text: "Analytics inspection for Analytics Fixture\nDetected vendors: Google Tag Manager, Meta Pixel, TikTok Pixel, LinkedIn Insight\nRecent dataLayer entries: page_view, view_item, add_to_cart",
					},
				],
				details: proofDetails,
				isError: false,
				timestamp: Date.now(),
			};

			const errorMessage = document.createElement("tool-message");
			errorMessage.toolCall = {
				type: "toolCall",
				id: "call_error",
				name: "inspect_analytics",
				arguments: { maxEvents: 8 },
			};
			errorMessage.result = {
				role: "toolResult",
				toolCallId: "call_error",
				toolName: "inspect_analytics",
				content: [{ type: "text", text: "No inspectable page tab found in the browser" }],
				details: {},
				isError: true,
				timestamp: Date.now(),
			};

			root.append(successMessage, errorMessage);
			document.body.append(root);
		}, details);

		await page.waitForTimeout(500);

		const text = await page.locator("body").innerText();
		const styleChecks = await page.evaluate(() => {
			const pill = document.querySelector(".rounded-full");
			const pillStyles = pill ? getComputedStyle(pill) : null;
			const bodyStyles = getComputedStyle(document.body);

			return {
				hasAppCss: Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith("/app.css")),
				pillBorderRadius: pillStyles?.borderRadius || "",
				pillBackgroundColor: pillStyles?.backgroundColor || "",
				bodyBackgroundColor: bodyStyles.backgroundColor,
			};
		});
		const assertions = {
			hasInspectorTitle: text.includes("Analytics Inspector"),
			hasGtm: text.includes("Google Tag Manager"),
			hasMeta: text.includes("Meta Pixel"),
			hasTikTok: text.includes("TikTok Pixel"),
			hasLinkedIn: text.includes("LinkedIn Insight"),
			hasPageView: text.includes("page_view"),
			hasViewItem: text.includes("view_item"),
			hasAddToCart: text.includes("add_to_cart"),
			hasGracefulError: text.includes("No inspectable page tab found in the browser"),
			hasAppCss: styleChecks.hasAppCss,
			hasStyledPill: styleChecks.pillBorderRadius !== "0px" && styleChecks.pillBackgroundColor !== "rgba(0, 0, 0, 0)",
		};

		const passed = Object.values(assertions).every(Boolean);
		await page.screenshot({ path: path.join(artifactDir, "analytics-ui-proof.png"), fullPage: true });
		await writeFile(
			path.join(artifactDir, "report.json"),
			JSON.stringify(
				{
					timestamp: new Date().toISOString(),
					artifactDir,
					assertions,
					styleChecks,
					passed,
					text,
				},
				null,
				2,
			),
		);

		if (!passed) {
			throw new Error(`Analytics UI validation failed: ${JSON.stringify(assertions)}`);
		}

		console.log(
			JSON.stringify(
				{
					artifactDir,
					assertions,
					passed,
				},
				null,
				2,
			),
		);
	} finally {
		await context.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
