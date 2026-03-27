import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs";

const ROOT = "/Users/rajeev/Code/sitegeist-src";
const DIST_DIR = path.join(ROOT, "dist-chrome");
const ARTIFACTS_ROOT = path.join(ROOT, "output", "playwright");
const ENV_FILE = "/Users/rajeev/.config/claude-openrouter/env.sh";

function readOpenRouterKey() {
	return readFile(ENV_FILE, "utf8").then((text) => {
		const match = text.match(/OPENROUTER_API_KEY\s*=\s*['"]?([^'"\n]+)['"]?/);
		if (!match) throw new Error(`Could not find OPENROUTER_API_KEY in ${ENV_FILE}`);
		return match[1];
	});
}

async function startFixtureServer() {
	const fixturePath = path.join(ROOT, "tests/fixtures/analytics-fixture.html");
	const fixtureHtml = await readFile(fixturePath, "utf8");

	const server = http.createServer((request, response) => {
		if (request.url === "/analytics-fixture.html" || request.url === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(fixtureHtml);
			return;
		}

		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("Not found");
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not determine analytics fixture server address");
	}

	return {
		server,
		url: `http://127.0.0.1:${address.port}/analytics-fixture.html`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

async function waitForInspectionResult(page, prompt, timeoutMs = 90_000) {
	const start = Date.now();
	let sawActivity = false;
	while (Date.now() - start < timeoutMs) {
		const text = await page.locator("body").innerText();
		const toolState = await page.evaluate(() => {
			const toolMessage = document.querySelector("tool-message");
			const streamingContainer = document.querySelector("streaming-message-container");
			return {
				hasToolResult: Boolean(toolMessage?.result),
				isToolStreaming: Boolean(toolMessage?.isStreaming),
				hasStreamingCursor: streamingContainer?.innerText?.trim().length > 0,
			};
		});
		if (text.includes("Thinking") || text.includes("Stop")) {
			sawActivity = true;
		}
		if (
			toolState.hasToolResult &&
			(text.includes("Google Tag Manager") ||
				text.includes("Meta Pixel") ||
				text.includes("TikTok Pixel") ||
				text.includes("LinkedIn Insight") ||
				text.includes("page_view"))
		) {
			return text;
		}
		if (
			sawActivity &&
			toolState.hasToolResult &&
			!toolState.isToolStreaming &&
			!toolState.hasStreamingCursor &&
			!text.includes("Thinking") &&
			!text.includes("Stop") &&
			text !== prompt
		) {
			return text;
		}
		await page.waitForTimeout(500);
	}
	throw new Error("Timed out waiting for Sitegeist to finish the analytics inspection");
}

async function main() {
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const artifactDir = path.join(ARTIFACTS_ROOT, `analytics-inspector-${timestamp}`);
	const profileDir = path.join(ARTIFACTS_ROOT, `analytics-profile-${timestamp}`);
	await mkdir(artifactDir, { recursive: true });
	await rm(profileDir, { recursive: true, force: true });
	const consoleMessages = [];
	const fixtureServer = await startFixtureServer();

	const openRouterKey = await readOpenRouterKey();
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

		const extensionPage = await context.newPage();
		extensionPage.on("console", (message) => {
			consoleMessages.push({
				type: message.type(),
				text: message.text(),
			});
		});
		extensionPage.on("pageerror", (error) => {
			consoleMessages.push({
				type: "pageerror",
				text: error.message,
			});
		});
		await extensionPage.goto("chrome://extensions/");
		await extensionPage.evaluate(
			async ({ extensionId }) => {
				await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
				await chrome.developerPrivate.updateExtensionConfiguration({
					extensionId,
					userScriptsAccess: true,
					fileAccess: true,
				});
			},
			{ extensionId },
		);

		await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
		await extensionPage.waitForTimeout(3_000);
		await extensionPage.evaluate(async (apiKey) => {
			const db = await new Promise((resolve, reject) => {
				const req = indexedDB.open("sitegeist-storage");
				req.onerror = () => reject(req.error);
				req.onsuccess = () => resolve(req.result);
			});
			await new Promise((resolve, reject) => {
				const tx = db.transaction(["provider-keys"], "readwrite");
				tx.objectStore("provider-keys").put(apiKey, "openrouter");
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
		}, openRouterKey);
		await extensionPage.reload();
		await extensionPage.waitForTimeout(4_000);

		const targetPage = await context.newPage();
		await targetPage.goto(fixtureServer.url);
		await targetPage.screenshot({ path: path.join(artifactDir, "fixture-page.png"), fullPage: true });
		await targetPage.bringToFront();

		const prompt =
			"Call the inspect_analytics tool on the current page now. Do not answer from memory and do not skip the tool. After the tool returns, summarize the detected tags and the recent dataLayer events.";
		await extensionPage.locator('textarea[placeholder="Type a message..."]').fill(prompt);
		await extensionPage.keyboard.press("Enter");
		let sidepanelText = "";
		let waitError = null;
		try {
			sidepanelText = await waitForInspectionResult(extensionPage, prompt);
		} catch (error) {
			waitError = error instanceof Error ? error.message : String(error);
			sidepanelText = await extensionPage.locator("body").innerText();
		}

		await extensionPage.screenshot({ path: path.join(artifactDir, "sitegeist-analytics-card.png"), fullPage: true });
		const styleChecks = await extensionPage.evaluate(() => {
			const messageCard = document.querySelector("tool-message > div");
			const messageCardStyles = messageCard ? getComputedStyle(messageCard) : null;
			const bodyStyles = getComputedStyle(document.body);

			return {
				hasAppCss: Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith("/app.css")),
				cardBorderRadius: messageCardStyles?.borderRadius || "",
				cardBackgroundColor: messageCardStyles?.backgroundColor || "",
				hasThemedCardClasses:
					messageCard instanceof HTMLElement &&
					messageCard.classList.contains("border") &&
					messageCard.classList.contains("bg-card") &&
					messageCard.classList.contains("rounded-md"),
				bodyBackgroundColor: bodyStyles.backgroundColor,
			};
		});
		const toolDebug = await extensionPage.evaluate(() => {
			const toolMessage = document.querySelector("tool-message");
			return toolMessage
				? {
						result: toolMessage.result ?? null,
						toolCall: toolMessage.toolCall ?? null,
						pending: toolMessage.pending ?? null,
						isStreaming: toolMessage.isStreaming ?? null,
					}
				: null;
		});
		await writeFile(path.join(artifactDir, "sidepanel.html"), await extensionPage.content());
		const assertions = {
			hasInspectorCard: sidepanelText.includes("Analytics Inspector"),
			hasGtm: sidepanelText.includes("Google Tag Manager"),
			hasMeta: sidepanelText.includes("Meta Pixel"),
			hasTiktok: sidepanelText.includes("TikTok Pixel"),
			hasLinkedIn: sidepanelText.includes("LinkedIn Insight"),
			hasPageView: sidepanelText.includes("page_view"),
			hasViewItem: sidepanelText.includes("view_item"),
			hasAddToCart: sidepanelText.includes("add_to_cart"),
			hasAppCss: styleChecks.hasAppCss,
			hasStyledCard: styleChecks.cardBorderRadius !== "0px" && styleChecks.hasThemedCardClasses,
		};

		const passed = Object.values(assertions).every(Boolean);
		const report = {
			timestamp: new Date().toISOString(),
			artifactDir,
			prompt,
			targetUrl: targetPage.url(),
			assertions,
			styleChecks,
			passed,
			sidepanelText,
			consoleMessages,
			toolDebug,
			waitError,
		};

		await writeFile(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2));

		if (!passed) {
			throw new Error(`Analytics inspector validation failed: ${JSON.stringify({ ...assertions, waitError })}`);
		}

		console.log(JSON.stringify(report, null, 2));
	} finally {
		await fixtureServer.close();
		await context.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
