import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function launchConfiguredContext(profileName) {
	const profileDir = path.join(ARTIFACTS_ROOT, profileName);
	await rm(profileDir, { recursive: true, force: true });
	const browserChannel = process.env.SITEGEIST_BROWSER_CHANNEL?.trim();
	const context = await chromium.launchPersistentContext(profileDir, {
		...(browserChannel ? { channel: browserChannel } : {}),
		headless: false,
		args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
	});

	let serviceWorker = context.serviceWorkers()[0];
	if (!serviceWorker) {
		serviceWorker = await context.waitForEvent("serviceworker", { timeout: 45_000 });
	}

	const extensionId = new URL(serviceWorker.url()).host;
	return { context, extensionId };
}

async function configureSitegeist(extPage, extensionId, openRouterKey) {
	await extPage.goto("chrome://extensions/");
	await extPage.evaluate(
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

	await extPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
	await extPage.waitForTimeout(3_000);

	await extPage.evaluate(async (apiKey) => {
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

	await extPage.reload();
	await extPage.waitForTimeout(4_000);
	await extPage.waitForFunction(() => typeof window.__sitegeistTest?.sendMessage === "function", null, {
		timeout: 15_000,
	});
}

async function captureScreenshot(page, artifactDir, name) {
	try {
		await page.screenshot({
			path: path.join(artifactDir, `${name}.png`),
			fullPage: true,
		});
		return true;
	} catch {
		return false;
	}
}

async function getVisiblePage(context) {
	const pages = context.pages().filter((page) => {
		const url = page.url();
		return url && !url.startsWith("chrome-extension://") && !url.startsWith("chrome://");
	});
	return pages.at(-1) ?? null;
}

async function collectPageState(page) {
	return page.evaluate(() => ({
		url: location.href,
		title: document.title,
		body: (document.body?.innerText || "").slice(0, 5_000),
	}));
}

function normalizeText(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

async function waitForCondition(context, check, timeoutMs = 90_000) {
	const start = Date.now();
	let lastPage = await getVisiblePage(context);
	let lastState = null;
	if (lastPage) {
		try {
			lastState = await collectPageState(lastPage);
		} catch {}
	}

	while (Date.now() - start < timeoutMs) {
		const page = (await getVisiblePage(context)) ?? lastPage;
		if (page) {
			lastPage = page;
			try {
				lastState = await collectPageState(page);
				if (check(lastState)) {
					return { page, state: lastState };
				}
			} catch {
				// Navigation can briefly destroy the execution context; retry on the next poll.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	throw new Error(`Timed out waiting for expected page state: ${JSON.stringify(lastState, null, 2)}`);
}

async function waitForPageCondition(page, check, timeoutMs = 90_000) {
	const start = Date.now();
	let lastState = null;

	while (Date.now() - start < timeoutMs) {
		try {
			lastState = await collectPageState(page);
			if (check(lastState)) {
				return { page, state: lastState };
			}
		} catch {
			// The page may be mid-navigation. Retry on the next poll.
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	throw new Error(`Timed out waiting for expected page state: ${JSON.stringify(lastState, null, 2)}`);
}

async function waitForAddToBag(page, productName, timeoutMs = 60_000) {
	const start = Date.now();
	let lastState = await collectPageState(page);

	while (Date.now() - start < timeoutMs) {
		lastState = await collectPageState(page);
		const hasAddAction = /add to (bag|basket|cart)/i.test(lastState.body);
		if (lastState.url.includes("/p/") && lastState.body.includes(productName) && hasAddAction) {
			return lastState;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	throw new Error(`Timed out waiting for add-to-bag state: ${JSON.stringify(lastState, null, 2)}`);
}

async function sendPrompt(extPage, extensionId, prompt) {
	const teststeps = encodeURIComponent(JSON.stringify([prompt]));
	const model = encodeURIComponent("openai/gpt-5.1-codex");
	await extPage.goto(
		`chrome-extension://${extensionId}/sidepanel.html?teststeps=${teststeps}&provider=openrouter&model=${model}`,
	);
	await extPage.waitForFunction(() => typeof window.__sitegeistTest?.waitForIdle === "function", null, {
		timeout: 15_000,
	});
}

async function waitForAgentIdle(extPage, timeoutMs = 120_000) {
	await extPage.evaluate(async (timeout) => {
		await window.__sitegeistTest.waitForIdle(timeout);
	}, timeoutMs);
}

async function readTranscript(extPage) {
	return extPage.evaluate(() => window.__sitegeistTest?.getTranscript?.() ?? document.body.innerText).catch(() => "");
}

async function writeFailureContext({ artifactDir, prefix, extPage, targetPage, error }) {
	const errorText = error instanceof Error ? `${error.stack || error.message}` : String(error);
	await writeFile(path.join(artifactDir, `${prefix}-error.txt`), errorText);

	try {
		const transcript = await readTranscript(extPage);
		await writeFile(path.join(artifactDir, `${prefix}-transcript.txt`), transcript);
	} catch {}

	if (targetPage) {
		try {
			await captureScreenshot(targetPage, artifactDir, `${prefix}-target-failure`);
		} catch {}
		try {
			await writeFile(
				path.join(artifactDir, `${prefix}-target-state.json`),
				JSON.stringify(await collectPageState(targetPage), null, 2),
			);
		} catch {}
	}

	try {
		await captureScreenshot(extPage, artifactDir, `${prefix}-sidepanel-failure`);
	} catch {}
}

async function runRangeRoverJourney(openRouterKey, artifactDir) {
	const { context, extensionId } = await launchConfiguredContext("live-range-rover-proof-profile");
	let extPage;
	let target;
	try {
		const optionsUrl = "https://www.rangerover.com/en-gb/range-rover-sport/options-and-accessories.html";
		const modelsUrl = "https://www.rangerover.com/en-gb/range-rover-sport/models-and-specifications.html";
		extPage = await context.newPage();
		await configureSitegeist(extPage, extensionId, openRouterKey);

		target = await context.newPage();
		await target.goto("https://www.rangerover.com/en-gb/index.html", { waitUntil: "domcontentloaded" });
		await captureScreenshot(target, artifactDir, "range-rover-homepage-start");
		await target.bringToFront();

		const step1Prompt =
			"On the currently open Range Rover homepage, first accept the cookie banner or consent prompt if one appears by choosing Accept All or the equivalent accept action. Then close any other blocking overlay if needed. Open the dedicated Range Rover Sport vehicle page by using the EXPLORE link or button for Range Rover Sport. Do not stop on the homepage. Stop only when the URL contains /new-range-rover-sport/ or /range-rover-sport/ and the page clearly shows RANGE ROVER SPORT.";
		await sendPrompt(extPage, extensionId, step1Prompt);
		const step1 = await waitForCondition(
			context,
			(state) =>
				(state.url.includes("/new-range-rover-sport/") || state.url.includes("/range-rover-sport/")) &&
				/RANGE ROVER SPORT/i.test(state.body),
		);
		await captureScreenshot(step1.page, artifactDir, "range-rover-step1-sport-page");

		const step2Prompt = `On the current Range Rover Sport page, first accept any cookie or consent banner if it appears by choosing Accept All or the equivalent accept action. Then close any other blocking overlay if needed. Navigate directly to this exact Range Rover Sport Options and Accessories URL: ${optionsUrl}. Do not stay on the overview page. Stop only when that page clearly shows OPTIONS AND ACCESSORIES.`;
		await sendPrompt(extPage, extensionId, step2Prompt);
		const step2 = await waitForCondition(
			context,
			(state) => state.url.includes("/options-and-accessories.html") && /OPTIONS AND ACCESSORIES/i.test(state.body),
		);
		await captureScreenshot(step2.page, artifactDir, "range-rover-step2-options-and-accessories");

		const step3Prompt = `On the current Range Rover Sport Options and Accessories page, first accept any cookie or consent banner if it appears by choosing Accept All or the equivalent accept action. Then close any other blocking overlay if needed. Navigate directly to this exact Range Rover Sport Models and Specifications URL: ${modelsUrl}. Stop only when that page clearly shows MODELS AND SPECIFICATIONS.`;
		await sendPrompt(extPage, extensionId, step3Prompt);
		const step3 = await waitForCondition(
			context,
			(state) =>
				state.url.includes("/models-and-specifications.html") && /MODELS AND SPECIFICATIONS/i.test(state.body),
		);
		await captureScreenshot(step3.page, artifactDir, "range-rover-step3-models-and-specifications");

		return {
			site: "rangerover",
			startUrl: "https://www.rangerover.com/en-gb/index.html",
			step1: {
				prompt: step1Prompt,
				state: step1.state,
				passed: true,
			},
			step2: {
				prompt: step2Prompt,
				state: step2.state,
				passed: true,
			},
			step3: {
				prompt: step3Prompt,
				state: step3.state,
				passed: true,
			},
			transcript: await readTranscript(extPage),
			passed: true,
		};
	} catch (error) {
		if (extPage) {
			try {
				await writeFailureContext({
					artifactDir,
					prefix: "range-rover",
					extPage,
					targetPage: target,
					error,
				});
			} catch {}
		}
		throw error;
	} finally {
		await context.close();
	}
}

async function runJohnLewisJourney(openRouterKey, artifactDir) {
	const { context, extensionId } = await launchConfiguredContext("live-john-lewis-proof-profile");
	let extPage;
	let target;
	try {
		extPage = await context.newPage();
		await configureSitegeist(extPage, extensionId, openRouterKey);

		target = await context.newPage();
		await target.goto("https://www.johnlewis.com/search?search-term=candle", {
			waitUntil: "domcontentloaded",
		});
		await captureScreenshot(target, artifactDir, "john-lewis-search-results-start");
		await target.bringToFront();

		const step1Prompt =
			"On the currently open John Lewis candle search results page, first accept the cookie banner by choosing Allow all or the equivalent accept action. Then close any survey, feedback, sign-up, or other blocking overlay. Stay on the candle results page and stop once the results grid is clearly visible.";
		await sendPrompt(extPage, extensionId, step1Prompt);
		const step1 = await waitForPageCondition(
			target,
			(state) =>
				state.url.includes("/search?search-term=candle") &&
				/Sort by/i.test(state.body) &&
				/candle/i.test(state.body),
		);
		await captureScreenshot(step1.page, artifactDir, "john-lewis-step1-search-results");

		const firstProduct = await step1.page.evaluate(() => {
			const article = document.querySelector("main article");
			const firstLink = article?.querySelector('a[href^="/"]');
			const nameEl = article?.querySelector("h2");
			return {
				name:
					nameEl?.textContent?.replace(/\s+/g, " ").trim() ||
					firstLink?.textContent?.replace(/\s+/g, " ").trim() ||
					"",
				href: firstLink?.href || "",
			};
		});
		if (!firstProduct.name) {
			throw new Error("Could not determine the first John Lewis product name from the results page");
		}
		const expectedProductUrl = new URL(firstProduct.href);
		const expectedProductPath = expectedProductUrl.pathname;
		const productSlugNeedle = normalizeText(expectedProductPath.split("/").filter(Boolean)[0].replaceAll("-", " "));

		const step2Prompt = `On the current John Lewis candle search results page, first accept the cookie banner by choosing Allow all or the equivalent accept action if it appears. Then close or ignore any survey, feedback, sign-up, or other blocking overlay. Do not click "Leave feedback", wishlist controls, quick view controls, or survey links. Navigate directly to this exact product URL: ${firstProduct.href}. Stop once that product page clearly shows an Add to basket action for "${firstProduct.name}".`;
		await sendPrompt(extPage, extensionId, step2Prompt);
		const step2State = await waitForPageCondition(
			target,
			(state) => {
				return state.url.includes(expectedProductPath) && /Add to basket/i.test(state.body);
			},
			120_000,
		);
		await captureScreenshot(step2State.page, artifactDir, "john-lewis-step2-product-page");
		const liveProductTitle = await step2State.page.evaluate(() => {
			const heading = document.querySelector("h1");
			return heading?.textContent?.replace(/\s+/g, " ").trim() || document.title;
		});

		const step3Prompt = `On the current John Lewis product page, first accept the cookie banner by choosing Allow all or the equivalent accept action if it appears. Then close any survey, feedback, sign-up, or other blocking overlay if needed. Do not search or open recommendations. Click the visible main Add to basket button for the current product and stop as soon as the header basket count shows 1 item.`;
		await sendPrompt(extPage, extensionId, step3Prompt);
		const step3 = await waitForPageCondition(target, (state) => /1\s+items?\s+in basket/i.test(state.body), 120_000);
		await captureScreenshot(step3.page, artifactDir, "john-lewis-step3-added-to-basket");

		const step4Prompt = `On the current John Lewis product page, first accept the cookie banner by choosing Allow all or the equivalent accept action if it appears. Then close any survey, feedback, sign-up, or other blocking overlay if needed. Open the basket and stop once the basket clearly shows "${liveProductTitle}".`;
		await sendPrompt(extPage, extensionId, step4Prompt);
		const step4 = await waitForPageCondition(
			target,
			(state) => {
				const normalizedBody = normalizeText(state.body);
				return (
					state.url.includes("/basket") &&
					normalizedBody.includes(productSlugNeedle) &&
					/Continue to checkout/i.test(state.body)
				);
			},
			120_000,
		);
		await captureScreenshot(step4.page, artifactDir, "john-lewis-step4-basket");

		return {
			site: "johnlewis",
			startUrl: "https://www.johnlewis.com/search?search-term=candle",
			firstProduct,
			step1: {
				prompt: step1Prompt,
				state: step1.state,
				passed: true,
			},
			step2: {
				prompt: step2Prompt,
				state: step2State,
				passed: true,
			},
			step3: {
				prompt: step3Prompt,
				state: step3.state,
				passed: true,
			},
			step4: {
				prompt: step4Prompt,
				state: step4.state,
				passed: true,
			},
			transcript: await readTranscript(extPage),
			passed: true,
		};
	} catch (error) {
		if (extPage) {
			try {
				await writeFailureContext({
					artifactDir,
					prefix: "john-lewis",
					extPage,
					targetPage: target,
					error,
				});
			} catch {}
		}
		throw error;
	} finally {
		await context.close();
	}
}

async function main() {
	await mkdir(ARTIFACTS_ROOT, { recursive: true });
	const openRouterKey = await readOpenRouterKey();
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const artifactDir = path.join(ARTIFACTS_ROOT, `live-sitegeist-journeys-${timestamp}`);
	await mkdir(artifactDir, { recursive: true });
	const targets = (process.env.SITEGEIST_TARGETS || "rangerover,johnlewis")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);

	const rangeRover = targets.includes("rangerover") ? await runRangeRoverJourney(openRouterKey, artifactDir) : null;
	const johnLewis = targets.includes("johnlewis") ? await runJohnLewisJourney(openRouterKey, artifactDir) : null;

	const report = {
		generatedAt: new Date().toISOString(),
		artifactDir,
		model: "openai/gpt-5.1-codex",
		provider: "openrouter",
		rangeRover,
		johnLewis,
		targets,
		passed: [rangeRover, johnLewis].filter(Boolean).every((result) => result.passed),
	};

	const reportPath = path.join(artifactDir, "report.json");
	await writeFile(reportPath, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ reportPath, report }, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
