//#region src/helper.ts
/**
* A tagged template function that parses an HTML string into DOM elements.
*
* It supports embedding strings, numbers, single DOM elements (`HTMLElement`),
* as well as collections of elements (`Array` or `NodeList`).
*
* @example
* // 1. Single element
* const element = html`<div class="box">Hello World</div>`;
*
* @example
* // 2. Nested elements and arrays
* const listItems = [html`<li>Item 1</li>`, html`<li>Item 2</li>`];
* const list = html`<ul>${listItems}</ul>`;
*
* @param {TemplateStringsArray} strings - The array of literal string segments.
* @param {...unknown[]} values - The dynamic expressions interpolated into the template.
* @returns {Element | HTMLCollection} A single `Element` if the template contains exactly
* one top-level root element, otherwise an `HTMLCollection` of all root-level elements.
*/
function html(strings, ...values) {
	const template = document.createElement("template");
	template.innerHTML = strings.reduce((acc, str, i) => {
		const val = values[i];
		if (val instanceof HTMLElement || val instanceof Array || val instanceof NodeList) return `${acc}${str}<template data-html-id="value-${i}"></template>`;
		return acc + str + (val ?? "");
	}, "");
	template.content.querySelectorAll("[data-html-id]").forEach((el) => {
		const htmlId = el.dataset.htmlId;
		if (!htmlId) return;
		const idString = htmlId.split("-")[1];
		if (!idString) return;
		const targetValue = values[parseInt(idString, 10)];
		if (targetValue instanceof Array) {
			el.replaceWith(...targetValue);
			return;
		}
		if (targetValue instanceof NodeList) {
			el.replaceWith(...Array.from(targetValue));
			return;
		}
		if (targetValue instanceof HTMLElement) {
			el.replaceWith(targetValue);
			return;
		}
		console.error("Case not handled for", el);
	});
	const { children } = template.content;
	return children.length === 1 ? children[0] : children;
}
/**
* Captures the currently focused element and returns a function to restore focus to it.
*/
function trapFocus() {
	const lastFocused = document.activeElement;
	return () => {
		if (lastFocused instanceof HTMLElement && document.body.contains(lastFocused)) lastFocused.focus();
		else document.body.focus();
	};
}
/**
* Decodes HTML entities into their corresponding characters
* using a temporary <textarea> element.
*
* This approach leverages the browser's built-in HTML parser
* to convert entities like &amp;, &lt;, &#169;, etc. into
* their decoded character equivalents.
*
* ⚠️ Security note:
* This is safe in this context because the textarea element
* is never attached to the DOM. It is used only as an internal
* parsing utility. However, it still relies on innerHTML
* parsing behavior.
*
* @param {string} text - String containing HTML entities.
* @returns {string} Decoded string with HTML entities resolved.
*
* @example
* decodeEntities("Tom &amp; Jerry") // "Tom & Jerry"
* decodeEntities("&#169; &lt;test&gt;") // "© <test>"
*/
function decodeEntities(text) {
	const textarea = document.createElement("textarea");
	textarea.innerHTML = text;
	return textarea.value;
}
/**
* Parses OpenSearch/Elasticsearch highlight strings containing <em> tags
* and returns an array of text and DOM nodes.
*
* Only <em> and </em> tags are supported. All other HTML is treated as text.
*
* Workflow:
* - Splits input by <em> and </em>
* - Decodes HTML entities in all text parts
* - Wraps content inside <em> elements as DOM nodes
*
* @param {string} text - Highlight string (e.g. from OpenSearch highlight field)
* @returns {(string|HTMLElement)[]} Array of strings and <em> DOM elements
*
* @example
* parseHighlight("Test &amp; <em>Lorem</em> ipsum")
* // [
* //   "Test & ",
* //   <em>Lorem</em>,
* //   " ipsum"
* // ]
*
* @example
* parseHighlight("A <em>B &amp; C</em> D")
* // [
* //   "A ",
* //   <em>B & C</em>,
* //   " D"
* // ]
*/
function parseHighlight(text) {
	const parts = text.split(/(<\/?em>)/);
	const result = [];
	let insideEm = false;
	for (const part of parts) {
		if (!part) continue;
		if (part === "<em>") {
			insideEm = true;
			continue;
		}
		if (part === "</em>") {
			insideEm = false;
			continue;
		}
		const decoded = decodeEntities(part);
		if (insideEm) {
			const em = document.createElement("em");
			em.textContent = decoded;
			result.push(em);
		} else result.push(decoded);
	}
	return result;
}
function debounce(fn, delay) {
	let timeoutId;
	return (...args) => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => {
			fn(...args);
		}, delay);
	};
}
/**
* Fetches search results.
*
* Two transports are supported: the default `GET` sends the query as a URL
* param (used for typeahead/highlight lookups), while `POST` sends a prepared
* body - see {@link buildSearchRequestBody} - and is used when results need
* facet aggregations or filtering.
*
* @param url Endpoint. For `POST` any query string on it is stripped, since
* everything travels in the body.
* @param query Search phrase. Only used by the `GET` transport.
* @param signal Abort signal, so in-flight requests can be superseded.
* @param requestOptions Transport selection and the `POST` body.
*/
var fetchSearchResults = async (url, query, signal, requestOptions = {}) => {
	let response;
	if (requestOptions.method === "POST") {
		const postURL = new URL(url, window.location.origin);
		postURL.search = "";
		response = await fetch(postURL.toString(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(requestOptions.body),
			signal
		});
	} else {
		const searchURL = new URL(url, window.location.origin);
		searchURL.searchParams.set("query", query);
		response = await fetch(searchURL.toString(), { signal });
	}
	if (!response.ok) throw new Error(`Fetch data error: ${response.status}`);
	return response.json();
};
/**
* Creates a placeholder that is replaced with the built element on the first `build()` call.
*
* @param buildFunction Function creating the element.
*/
var createLazyComponent = (buildFunction) => {
	let isBuild = false;
	const placeholderEl = html`
    <div data-lazy-build="true"></div>
  `;
	const build = () => {
		if (isBuild) return;
		const newEl = buildFunction();
		placeholderEl.replaceWith(newEl);
		isBuild = true;
	};
	return {
		element: placeholderEl,
		build
	};
};
/**
* Adds the `namespace` query param to a `GET` search URL, so results are
* limited to one content namespace. A missing namespace is left off entirely,
* which searches across all of them.
*
* `POST` requests carry the namespace in the body instead - see
* `buildSearchRequestBody`.
*/
var withNamespaceParam = (url, namespace) => {
	if (!namespace) return url;
	const namespacedUrl = new URL(url, window.location.origin);
	namespacedUrl.searchParams.set("namespace", namespace);
	return namespacedUrl.toString();
};
var dispatchUrlChangeEvent = () => {
	window.dispatchEvent(new Event("urlchange"));
};
var onUrlChange = (handler) => {
	window.addEventListener("urlchange", () => {
		handler();
	});
};
var normalizeLabels = (labels) => {
	return Object.fromEntries(Object.entries(labels).map(([key, value]) => {
		return [key, typeof value === "string" ? () => value : value];
	}));
};
//#endregion
//#region src/renderers/renderers.ts
/**
* Resolves the destination URL of a hit from its `_id`.
*
* The index namespaces `_id` (e.g. `en:/en/blog/post`), so the `${namespace}:`
* prefix has to be stripped to get a usable URL. Hits without a namespace - or
* whose `_id` does not carry that exact prefix - are returned unchanged.
*
* @example
* getHitUrl({ _id: "en:/en/blog/post", _source: { namespace: "en" } })
* // "/en/blog/post"
*
* @example
* getHitUrl({ _id: "/index.html", _source: { namespace: null } })
* // "/index.html"
*/
function getHitUrl(item) {
	const id = item?._id ?? "";
	const namespace = item?._source?.namespace;
	if (namespace && id.startsWith(`${namespace}:`)) return id.slice(namespace.length + 1);
	return id;
}
function suggestionItem(item) {
	const id = crypto.randomUUID();
	const data = [];
	if (item.highlight?.["payload.title"]) data.push(...item.highlight["payload.title"]);
	if (item.highlight?.["payload.content"]) data.push(...item.highlight["payload.content"]);
	const content = data.map((el) => parseHighlight(el))[0];
	return html`
    <a href="${getHitUrl(item)}" id="${id}" class="stx-suggestion__item">
      <span>${content}</span>
    </a>
  `;
}
function groupItem(item) {
	if (!item._source.type) return;
	return html`
    <span class="stx-suggestion__category"> ${item._source.type} </span>
  `;
}
function clearIcon() {
	return "✕";
}
function searchIcon() {
	return "🔍";
}
//#endregion
//#region src/config.ts
var config = { debug: false };
/**
* Default URL param carrying the active search query.
*
* The query input writes it and the results panel reads it, so both sides must
* agree. Override per component with the `queryParam` option.
*/
var DEFAULT_QUERY_PARAM = "query";
/**
* URL param holding the active tab's id.
*
* It is written only while a non-default tab is selected, so the URL stays
* clean on the first tab.
*/
var ACTIVE_TAB_PARAM = "stx-tab";
//#endregion
//#region src/inline-search/default-config.ts
var defaultConfig = {
	input: {
		minSearchLength: 3,
		groupByCategory: true,
		showSearchButton: true,
		queryParam: DEFAULT_QUERY_PARAM,
		labels: {
			inputPlaceholder: "Search",
			inputLabel: "Search",
			clearButtonAria: "Clear search input",
			searchButtonAria: "Go to search page"
		},
		renderers: {
			suggestionItem,
			groupItem,
			clearIcon,
			searchIcon
		}
	},
	useNonModal: false,
	analytics: () => {}
};
//#endregion
//#region src/components/suggestions/suggestions.ts
var renderSuggestionListItem = (item, config) => {
	const elements = [];
	if (item.isFirstInGroup) {
		const groupItem = config.renderers.groupItem(item);
		if (groupItem) elements.push(html`<li>${groupItem}</li>`);
	}
	const suggestionItem = config.renderers.suggestionItem(item);
	if (suggestionItem) elements.push(html`<li role="option">${suggestionItem}</li>`);
	return elements;
};
function orderByTypeWithFlags(items) {
	const groups = /* @__PURE__ */ new Map();
	const order = [];
	for (const item of items) {
		const type = item._source.type ?? "__no_type__";
		if (!groups.has(type)) {
			groups.set(type, []);
			order.push(type);
		}
		groups.get(type).push(item);
	}
	const result = [];
	for (const type of order) groups.get(type).forEach((item, index) => {
		result.push({
			...item,
			isFirstInGroup: index === 0
		});
	});
	return result;
}
var createSuggestions = (response, config) => {
	let data = response.hits?.hits || [];
	if (config.groupByCategory) data = orderByTypeWithFlags(response.hits?.hits || []);
	return { element: html`
    <ul class="stx-suggestions-wrapper" role="listbox">
      ${data.map((el) => {
		return renderSuggestionListItem(el, config);
	}).flat()}
    </ul>
  ` };
};
//#endregion
//#region src/components/query-input/query-input.ts
var resolveConfig = (customConfig) => {
	return {
		...defaultConfig.input,
		...customConfig,
		queryParam: customConfig.queryParam || defaultConfig.input.queryParam,
		renderers: {
			...defaultConfig.input.renderers,
			...customConfig.renderers
		},
		labels: {
			...defaultConfig.input.labels,
			...Object.fromEntries(Object.entries(customConfig.labels || {}).filter(([, value]) => value !== void 0))
		}
	};
};
var createDebouncedSearch = (url, callback) => {
	let controller = null;
	return debounce(async (query) => {
		controller?.abort();
		controller = new AbortController();
		try {
			callback(await fetchSearchResults(url, query, controller.signal));
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return;
			console.error(error);
		}
	}, 300);
};
var updateSearchQuery = (query, queryParam) => {
	const url = new URL(window.location.href);
	url.searchParams.delete(queryParam);
	url.searchParams.set(queryParam, query);
	window.history.pushState({}, "", url);
	dispatchUrlChangeEvent();
};
function createQueryInput(customConfig) {
	const config = resolveConfig(customConfig);
	const inputTextId = crypto.randomUUID();
	const suggestionWrapperId = crypto.randomUUID();
	const { labels, renderers, queryParam } = config;
	const searchUrl = withNamespaceParam(typeof config.searchApiUrl === "string" ? config.searchApiUrl : config.searchApiUrl(), config.namespace);
	const queryInputEl = html`
    <div class="stx-query-input">
      <div class="stx-query-input__controls">
        <div class="stx-query-input__input-wrapper">
          <label for="${inputTextId}">${labels.inputLabel}</label>
          <input
            class="stx-query-input__input"
            type="text"
            placeholder="${labels.inputPlaceholder}"
            role="combobox"
            aria-expanded="false"
            aria-autocomplete="list"
            aria-controls="${suggestionWrapperId}"
            id="${inputTextId}"
          />
          <button
            class="stx-query-input__clear-button stx-hidden"
            type="button"
            aria-label="${labels.clearButtonAria}"
          >
            ${renderers.clearIcon()}
          </button>
        </div>
        <button
          class="stx-query-input__search-button"
          type="button"
          aria-label="${labels.searchButtonAria}"
        >
          ${renderers.searchIcon()}
        </button>
      </div>
      <div
        class="stx-query-input__suggestions-wrapper"
        id="${suggestionWrapperId}"
      ></div>
    </div>
  `;
	const inputEl = queryInputEl.querySelector(".stx-query-input__input");
	const suggestionContainer = queryInputEl.querySelector(".stx-query-input__suggestions-wrapper");
	const clearButton = queryInputEl.querySelector(".stx-query-input__clear-button");
	const searchButton = queryInputEl.querySelector(".stx-query-input__search-button");
	let activeIndex = -1;
	let suggestionListLenght = 0;
	/**
	* Whether the dropdown currently holds `initialQuery` results, so typing can
	* drop them without clearing (and flickering) live typeahead results.
	*/
	let showingInitialSuggestions = false;
	const closeSuggestions = () => {
		activeIndex = -1;
		suggestionListLenght = 0;
		showingInitialSuggestions = false;
		if (suggestionContainer) suggestionContainer.innerHTML = "";
	};
	/**
	* Submits the query. With `submitInPlace` the active query is written to the
	* URL so an adjacent results panel can react; otherwise the user is sent to
	* `searchPageUrl`.
	*/
	const submitQuery = (query) => {
		if (config.submitInPlace) {
			updateSearchQuery(query, queryParam);
			closeSuggestions();
			return;
		}
		if (config.searchPageUrl) {
			window.location.href = config.searchPageUrl(query).toString();
			return;
		}
		updateSearchQuery(query, queryParam);
	};
	let initialSuggestionsPromise = null;
	/** Fetches the `initialQuery` results once and caches them. */
	const prefetchInitialSuggestions = () => {
		if (!config.initialQuery) return null;
		if (!initialSuggestionsPromise) initialSuggestionsPromise = fetchSearchResults(searchUrl, config.initialQuery).catch((error) => {
			console.error(error);
			initialSuggestionsPromise = null;
			return null;
		});
		return initialSuggestionsPromise;
	};
	const showInitialSuggestions = async () => {
		if (!config.initialQuery || !suggestionContainer || inputEl.value) return;
		const response = await prefetchInitialSuggestions();
		if (!response || inputEl.value) return;
		const suggestionEl = createSuggestions(response, config);
		suggestionListLenght = response.hits.hits?.length || 0;
		activeIndex = -1;
		suggestionContainer.innerHTML = "";
		suggestionContainer.append(suggestionEl.element);
		showingInitialSuggestions = true;
	};
	queryInputEl.showInitialSuggestions = showInitialSuggestions;
	const updateActiveItem = () => {
		if (!suggestionContainer) return;
		suggestionContainer.querySelectorAll(".stx-suggestion__item").forEach((el, index) => {
			if (index === activeIndex) {
				el.classList.add("is-active");
				el.setAttribute("aria-selected", "true");
				el.scrollIntoView({ block: "nearest" });
				el.setAttribute("tabindex", "0");
				inputEl.setAttribute("aria-activedescendant", el.id);
			} else {
				el.classList.remove("is-active");
				el.setAttribute("aria-selected", "false");
				el.setAttribute("tabindex", "-1");
			}
		});
		if (activeIndex === -1) inputEl.removeAttribute("aria-activedescendant");
	};
	if (inputEl) {
		const onSearch = createDebouncedSearch(searchUrl, (results) => {
			const suggestionEl = createSuggestions(results, config);
			suggestionListLenght = results.hits.hits?.length || 0;
			activeIndex = -1;
			if (suggestionContainer) {
				suggestionContainer.innerHTML = "";
				suggestionContainer.append(suggestionEl.element);
			}
			showingInitialSuggestions = false;
		});
		if (config.submitInPlace) {
			const urlQuery = new URLSearchParams(window.location.search).get(queryParam) || "";
			if (urlQuery) {
				inputEl.value = urlQuery;
				clearButton?.classList.remove("stx-hidden");
			}
		}
		prefetchInitialSuggestions();
		inputEl.addEventListener("focus", () => {
			showInitialSuggestions();
		});
		inputEl.addEventListener("click", () => {
			showInitialSuggestions();
		});
		inputEl.addEventListener("input", (event) => {
			const { value } = event.target;
			clearButton.classList.toggle("stx-hidden", !value.length);
			if (!value.length) {
				closeSuggestions();
				showInitialSuggestions();
				return;
			}
			if (showingInitialSuggestions || value.length < config.minSearchLength) closeSuggestions();
			if (value.length >= config.minSearchLength) onSearch(value);
		});
		inputEl.addEventListener("keydown", (e) => {
			const { key } = e;
			if (key === "Enter") if (activeIndex > -1 && suggestionContainer) {
				e.preventDefault();
				suggestionContainer.querySelectorAll(".stx-suggestion__item")[activeIndex]?.click();
			} else submitQuery(inputEl.value);
			if (!suggestionListLenght) return;
			const maxIndex = suggestionListLenght;
			if (key === "ArrowDown") {
				e.preventDefault();
				if (maxIndex === 0) return;
				activeIndex = activeIndex < maxIndex ? activeIndex + 1 : 0;
				updateActiveItem();
			} else if (key === "ArrowUp") {
				e.preventDefault();
				if (maxIndex === 0) return;
				activeIndex = activeIndex > 0 ? activeIndex - 1 : maxIndex;
				updateActiveItem();
			} else if (key === "Escape") closeSuggestions();
		});
		suggestionContainer?.addEventListener("click", (e) => {
			const item = e.target.closest(".stx-suggestion__item");
			if (!item) return;
			e.preventDefault();
			const query = item.textContent?.trim() || "";
			inputEl.value = query;
			clearButton?.classList.remove("stx-hidden");
			submitQuery(query);
		});
	}
	if (clearButton && inputEl) clearButton.addEventListener("click", () => {
		inputEl.value = "";
		closeSuggestions();
		inputEl.focus();
		showInitialSuggestions();
	});
	if (searchButton) {
		const hasSubmitTarget = config.submitInPlace || config.searchPageUrl;
		if (config.showSearchButton && hasSubmitTarget) searchButton.addEventListener("click", () => {
			submitQuery(inputEl.value);
		});
		else searchButton.remove();
	}
	window.addEventListener("click", (e) => {
		const target = e.target;
		if (target !== queryInputEl && !target.closest(".stx-query-input")) closeSuggestions();
	});
	return {
		element: queryInputEl,
		inputEl
	};
}
//#endregion
export { config as a, fetchSearchResults as c, onUrlChange as d, trapFocus as f, DEFAULT_QUERY_PARAM as i, html as l, defaultConfig as n, getHitUrl as o, withNamespaceParam as p, ACTIVE_TAB_PARAM as r, createLazyComponent as s, createQueryInput as t, normalizeLabels as u };

//# sourceMappingURL=common-S2Xwo6A-.js.map