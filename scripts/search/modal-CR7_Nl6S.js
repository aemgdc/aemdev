import { f as trapFocus, l as html, t as createQueryInput } from "./common-S2Xwo6A-.js";
//#region src/inline-search/modal/modal.ts
var createSearchModal = (config) => {
	const { element: queryInput, inputEl } = createQueryInput(config.input);
	const dialogEl = html`
    <dialog class="stx-search-modal">${queryInput}</dialog>
  `;
	let restoreFocus;
	if (!dialogEl || !inputEl) throw new Error("test");
	const openModal = () => {
		if (dialogEl.open) return;
		restoreFocus = trapFocus();
		if (config.useNonModal) dialogEl.show();
		else dialogEl.showModal();
		inputEl.focus();
		config?.analytics?.({ type: "streamx_modal_search_open" });
	};
	const closeModal = () => {
		if (!dialogEl.open) return;
		dialogEl.close();
	};
	dialogEl.addEventListener("close", () => {
		if (restoreFocus) restoreFocus();
		config?.analytics?.({ type: "streamx_modal_search_close" });
	});
	dialogEl.addEventListener("click", (e) => {
		if (e.target && e.target === dialogEl) dialogEl.close();
	});
	return {
		element: dialogEl,
		openModal,
		closeModal
	};
};
//#endregion
export { createSearchModal as t };

//# sourceMappingURL=modal-CR7_Nl6S.js.map