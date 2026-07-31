//#region src/exports/eds/decorate-search-tab.ts
function decorate(block) {
	block.classList.add("stx-hidden");
	if (!document.querySelector(".stx-tabs")) console.error("The `stx-tab` blocks provides config for the `stx-tabs` block. The `stx-tabs` block is not found!. Please make sure you added it to the page before the `stx-tab`!");
}
//#endregion
export { decorate as default };

//# sourceMappingURL=search-tab.js.map