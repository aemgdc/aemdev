import { n as defaultConfig, o as getHitUrl, t as createQueryInput } from "./common-S2Xwo6A-.js";
import { t as createSearchModal } from "./modal-CR7_Nl6S.js";
//#region src/exports/search-inline.ts
var getTriggerOpenEl = (searchOpenElementSelector) => {
	if (!searchOpenElementSelector) throw new Error("No trigger selector provided!");
	const triggerEl = document.querySelector(searchOpenElementSelector);
	if (!triggerEl) throw new Error(`No trigger element found! Used selector: "${searchOpenElementSelector}`);
	return triggerEl;
};
var getTriggerCloseEl = (searchCloseElementSelector) => {
	if (!searchCloseElementSelector) return;
	return document.querySelector(searchCloseElementSelector);
};
var bootstrapModal = (config) => {
	const { openModal, closeModal, element } = createSearchModal(config);
	document.body.append(element);
	return {
		openModal,
		closeModal
	};
};
function mountSearchModal(customConfig) {
	const config = {
		...defaultConfig,
		...customConfig,
		input: {
			...defaultConfig.input,
			...customConfig.input,
			labels: {
				...defaultConfig.input.labels,
				...customConfig.input.labels
			},
			renderers: {
				...defaultConfig.input.renderers,
				...customConfig.input.renderers
			}
		}
	};
	const { searchOpenElementSelector, searchCloseElementSelector } = config;
	const triggerEl = getTriggerOpenEl(searchOpenElementSelector);
	let modalData = null;
	triggerEl.addEventListener("click", () => {
		if (!modalData) modalData = bootstrapModal(config);
		modalData.openModal();
	});
	if (searchCloseElementSelector) {
		const triggerCloseEl = getTriggerCloseEl(searchCloseElementSelector);
		if (triggerCloseEl) triggerCloseEl.addEventListener("click", () => {
			if (modalData) modalData.closeModal();
		});
	}
}
function createSearchInput(customConfig, mountPoint) {
	const { element } = createQueryInput(customConfig);
	if (mountPoint.tagName === "INPUT") mountPoint.replaceWith(element);
	else mountPoint.append(element);
	return element;
}
//#endregion
export { createSearchInput, getHitUrl, mountSearchModal };

//# sourceMappingURL=streamx-search-inline.js.map