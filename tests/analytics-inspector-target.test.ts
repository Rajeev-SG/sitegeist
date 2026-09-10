import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	findInspectableAnalyticsTarget,
	getCandidateTabIds,
	isInspectablePageUrl,
} from "../src/tools/analytics-inspector-target.js";

const FIXTURE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/analytics-fixture.html"))
	.href;

test("isInspectablePageUrl rejects browser and extension pages", () => {
	assert.equal(isInspectablePageUrl("https://example.com"), true);
	assert.equal(isInspectablePageUrl("file:///tmp/fixture.html"), true);
	assert.equal(isInspectablePageUrl("chrome-extension://abc/sidepanel.html"), false);
	assert.equal(isInspectablePageUrl("chrome://extensions/"), false);
});

test("getCandidateTabIds prioritizes the active current-window tab without needing tab urls", () => {
	const currentWindowTabs = [
		{ id: 2, active: false, lastAccessed: 20 },
		{ id: 1, active: true, lastAccessed: 10 },
	];
	const allTabs = [
		{ id: 3, active: false, lastAccessed: 30 },
		{ id: 1, active: true, lastAccessed: 10 },
	];

	assert.deepEqual(getCandidateTabIds(currentWindowTabs, allTabs), [1, 2, 3]);
});

test("findInspectableAnalyticsTarget skips internal pages and collector failures", async () => {
	const currentWindowTabs = [
		{ id: 11, active: true, lastAccessed: 50 },
		{ id: 12, active: false, lastAccessed: 40 },
	];
	const allTabs = [{ id: 13, active: false, lastAccessed: 30 }];

	const seen: number[] = [];
	const result = await findInspectableAnalyticsTarget(currentWindowTabs, allTabs, async (tabId) => {
		seen.push(tabId);
		if (tabId === 11) {
			return { pageUrl: "chrome-extension://mhmglodmlggocbagjflcjbiagdpihape/sidepanel.html" };
		}
		if (tabId === 12) {
			throw new Error("Cannot access tab");
		}
		return { pageUrl: FIXTURE_URL };
	});

	assert.deepEqual(seen, [11, 12, 13]);
	assert.equal(result.tabId, 13);
	assert.equal(result.snapshot.pageUrl, FIXTURE_URL);
});
