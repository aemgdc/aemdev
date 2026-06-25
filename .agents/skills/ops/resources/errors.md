# Error Handling

When the API returns an error, explain the cause and how to fix it. Always show the actual API error message when available — it often contains specific details.

| HTTP Code | Cause | Tell User | Fix |
|-----------|-------|-----------|-----|
| **400** | Malformed request | "The request format is invalid. Check the path or payload syntax." | Review path format, ensure JSON/YAML is valid |
| **401** | Token expired or missing | "Your session has expired. You need to log in again." | Run `Skill({ skill: "aem-project-management:auth" })` |
| **403** | Insufficient permissions | Show actual API error. If none: "You don't have permission for this operation." | Contact site admin to grant the required role |
| **404** (on path) | Content doesn't exist | "The path '{path}' was not found. Check if it exists in your content source." | Verify path spelling, check SharePoint/Drive/DA |
| **404** (on org/site) | Org or site not configured | "The organization '{org}' or site '{site}' is not found. It may not be onboarded to Admin Service." | Verify org/site names, contact Adobe support if new project |
| **409** | Conflict (already exists) | "This resource already exists. Use update instead of create." | Use POST instead of PUT, or check if it already exists |
| **422** | Invalid content | "The content failed validation: {error details from API}" | Fix the specific validation error returned |
| **429** | Rate limited | "Too many requests. Wait a moment before retrying." | Wait 30–60 seconds, then retry |
| **500** | Server error | "The Admin Service encountered an error. This is temporary." | Wait and retry; if persistent, check status.adobe.com |
| **502/503** | Service unavailable | "The Admin Service is temporarily unavailable." | Wait a few minutes and retry |
