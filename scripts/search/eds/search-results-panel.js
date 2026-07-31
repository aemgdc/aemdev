import { t as createResultsPanel } from "../search-results-panel-oPiJHnTQ.js";
import { a as readPanelOptions, i as readInputOptions, n as loadCssFile, o as replaceElWithError, t as getEDSConfig } from "../eds-helper-B2lm9102.js";
//#region src/exports/eds/decorate-results-panel.ts
function decorate(block, renderers) {
	loadCssFile("/scripts/search/streamx-search.css");
	const config = getEDSConfig(block);
	block.innerHTML = "";
	if (!config.searchApiUrl) {
		replaceElWithError(block, "The <em>Results panel</em> block requires <i>searchApiUrl</i>");
		return;
	}
	const inputOptions = readInputOptions(config);
	const inputConfig = {
		searchApiUrl: config.searchApiUrl,
		...inputOptions,
		renderers
	};
	const resultsRenderers = Object.fromEntries(Object.entries(renderers || {}).filter(([, renderer]) => renderer !== void 0));
	const resultPanel = createResultsPanel(inputConfig, {
		...readPanelOptions(config),
		queryParam: inputOptions.queryParam,
		renderers: resultsRenderers
	});
	block.append(resultPanel);
}
//#endregion
export { decorate as default };

//# sourceMappingURL=search-results-panel.js.map