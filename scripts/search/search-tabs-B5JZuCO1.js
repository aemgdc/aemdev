import { a as config, l as html, r as ACTIVE_TAB_PARAM, s as createLazyComponent, t as createQueryInput } from "./common-S2Xwo6A-.js";
import { t as createResultsPanel } from "./results-panel-P1vgMqsC.js";
//#region src/components/tabs/tabs.ts
var resolvedTab = (tabsConfig, customRenderers = {}) => {
	return tabsConfig.map((c) => ({
		...c,
		results: {
			pageSize: 10,
			...c.results,
			stateKey: c.results?.stateKey ?? String(c.id),
			renderers: {
				...customRenderers,
				...c.results?.renderers
			}
		}
	}));
};
var getTabId = (id) => `stx-tab-${id}`;
var getTabContentId = (id) => `stx-tab-content-${id}`;
var createTabButton = (tabData, isSelected) => {
	const { id, displayName } = tabData;
	return html`
    <button
      id="${getTabId(id)}"
      role="tab"
      aria-selected="${String(isSelected)}"
      aria-controls="${getTabContentId(id)}"
      tabindex="${isSelected ? "0" : "-1"}"
      class="stx-tabs__button"
    >
      ${displayName}
    </button>
  `;
};
var createTabContent = (tabData, isSelected) => {
	const { id } = tabData;
	const { element, build } = createLazyComponent(() => {
		return createResultsPanel(tabData.results);
	});
	return {
		element: html`
    <div
      id="${getTabContentId(id)}"
      role="tabpanel"
      aria-labelledby="${getTabId(id)}"
      class="stx-tabs__content"
      ${isSelected ? "" : "hidden"}
    >
      <div>${element}</div>
    </div>
  `,
		build
	};
};
function createTabs(tabsConfig, customRenderers) {
	const tabs = resolvedTab(tabsConfig, customRenderers);
	const initialTabParam = new URLSearchParams(window.location.search).get(ACTIVE_TAB_PARAM);
	const initialIndex = Math.max(0, tabs.findIndex((tab) => String(tab.id) === initialTabParam));
	const updateActiveTabParam = (tabId, isDefault) => {
		const url = new URL(window.location.href);
		if (isDefault) url.searchParams.delete(ACTIVE_TAB_PARAM);
		else url.searchParams.set(ACTIVE_TAB_PARAM, tabId);
		window.history.replaceState({}, "", url);
	};
	const buttonList = tabs.map((el, index) => createTabButton(el, index === initialIndex));
	const tabsLazyMounts = [];
	const contentList = [];
	tabs.forEach((el, index) => {
		const { element, build } = createTabContent(el, index === initialIndex);
		tabsLazyMounts.push(build);
		contentList.push(element);
	});
	const tabsEl = html`
    <div class="stx-tabs">
      <div role="tablist" class="stx-tabs__buttons">${buttonList}</div>
      ${contentList}
    </div>
  `;
	const activateTab = (selectedTabButton) => {
		const selectedIndex = buttonList.indexOf(selectedTabButton);
		buttonList.forEach((button, index) => {
			const isSelected = index === selectedIndex;
			const contentElId = button.getAttribute("aria-controls");
			const contentEl = tabsEl.querySelector(`#${contentElId}`);
			button.setAttribute("aria-selected", String(isSelected));
			button.tabIndex = isSelected ? 0 : -1;
			if (contentEl && contentEl instanceof HTMLElement) {
				contentEl.hidden = !isSelected;
				if (isSelected) tabsLazyMounts[index]();
			}
		});
		if (selectedIndex >= 0) updateActiveTabParam(String(tabs[selectedIndex].id), selectedIndex === 0);
	};
	tabsLazyMounts[initialIndex]();
	const onKeyDown = (e) => {
		const { target } = e;
		if (!(target instanceof HTMLButtonElement)) return;
		const currentButtonIndex = buttonList.indexOf(target);
		const tabCount = buttonList.length;
		let nextIndex;
		switch (e.key) {
			case "ArrowRight":
				e.preventDefault();
				nextIndex = (currentButtonIndex + 1) % tabCount;
				break;
			case "ArrowLeft":
				e.preventDefault();
				nextIndex = (currentButtonIndex - 1 + tabCount) % tabCount;
				break;
			case "Home":
				e.preventDefault();
				nextIndex = 0;
				break;
			case "End":
				e.preventDefault();
				nextIndex = tabCount - 1;
				break;
			default: return;
		}
		if (nextIndex !== currentButtonIndex) {
			buttonList[nextIndex].focus();
			buttonList[nextIndex].click();
		}
	};
	buttonList.forEach((tab) => {
		tab.addEventListener("click", () => {
			activateTab(tab);
		});
		tab.addEventListener("keydown", (e) => {
			onKeyDown(e);
		});
	});
	return tabsEl;
}
//#endregion
//#region src/exports/search-tabs.ts
var createSearchTabs = (inputConfig, tabsConfig, resultsRenderers, debug) => {
	if (debug) config.debug = true;
	return html` <div class="stx-search-tabs">
    ${createQueryInput(inputConfig).element} ${createTabs(tabsConfig, resultsRenderers)}
  </div>`;
};
//#endregion
export { createSearchTabs as t };

//# sourceMappingURL=search-tabs-B5JZuCO1.js.map