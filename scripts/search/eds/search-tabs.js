import { t as createSearchTabs } from "../search-tabs-B5JZuCO1.js";
import { a as readPanelOptions, i as readInputOptions, n as loadCssFile, o as replaceElWithError, r as mergeEDSConfigs, t as getEDSConfig } from "../eds-helper-B2lm9102.js";
//#region src/exports/eds/decorate-search-tabs.ts
function decorate(block, tabSelector, renderers) {
	loadCssFile("/scripts/search/streamx-search.css");
	const config = getEDSConfig(block);
	block.innerHTML = "";
	if (!config.searchApiUrl) {
		replaceElWithError(block, "The <em>Search Tabs</em> block requires <i>searchApiUrl</i>");
		return;
	}
	const inputOptions = readInputOptions(config);
	const inputConfig = {
		searchApiUrl: config.searchApiUrl,
		...inputOptions,
		renderers
	};
	const tabsConfigs = [...document.querySelectorAll(tabSelector)].map((tab) => {
		const tabConfig = getEDSConfig(tab);
		const panelOptions = mergeEDSConfigs(config, tabConfig);
		if (!tabConfig.id) {
			replaceElWithError(block, "The <em>Search Tab</em> block requires <i>id</i>");
			return;
		}
		if (!tabConfig.displayName) {
			replaceElWithError(block, "The <em>Search Tab</em> block requires <i>displayName</i>");
			return;
		}
		if (!panelOptions.dataSources) {
			replaceElWithError(block, "The <em>Search Tab</em> block requires <i>dataSources</i>");
			return;
		}
		tab.remove();
		return {
			id: tabConfig.id,
			displayName: tabConfig.displayName,
			results: {
				...readPanelOptions(panelOptions),
				queryParam: inputOptions.queryParam
			}
		};
	});
	const resultsRenderers = Object.fromEntries(Object.entries(renderers || {}).filter(([, renderer]) => renderer !== void 0));
	const searchTab = createSearchTabs(inputConfig, tabsConfigs.filter((tab) => tab !== void 0), resultsRenderers);
	block.append(searchTab);
}
//#endregion
export { decorate as default };

//# sourceMappingURL=search-tabs.js.map