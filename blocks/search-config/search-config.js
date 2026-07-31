// `search-config` is a headless configuration block: its key/value rows are
// read and removed by the header decorator (see blocks/header/header.js,
// parseSearchConfig). It has no visual decoration of its own. This no-op exists
// only so the EDS block loader gets a 200 instead of 403/404 when it fetches a
// decorator by naming convention.
export default function decorate() {}
