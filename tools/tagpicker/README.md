# AEM Tag Picker Tool

A web-based tool for selecting AEM (Adobe Experience Manager) tags that are managed within an AEM Cloud environment. This tool provides an interactive interface for browsing AEM's hierarchical tag structure and inserting selected tags into content within DA.

## Overview

The Tag Picker tool consists of two main components:

1. **TagsServlet** - A Java REST API that exposes AEM tags
2. **TagPicker UI** - A DA Plugin for tag selection

## Components

### TagsServlet (Java Backend)

A Sling servlet that provides REST endpoints to retrieve tag information from AEM's tag repository.

**Location**: `TagsServlet.java`

**Service Endpoint**: `/services/tagsservlet`

**Methods**: GET only (safe methods)

**Features**:
- Retrieves all tags from AEM's tag repository (`/content/cq:tags`)
- Supports multi-language tag retrieval with fallback to English
- Handles nested tag hierarchies with parent-child relationships
- Returns tag metadata including custom properties
- Supports 9+ languages: English, Spanish, German, French, Italian, Japanese, Korean, Simplified Chinese, Traditional Chinese

**Request Formats**:

| Request | Purpose |
|---------|---------|
| `/services/tagsservlet` | Get all tags with complete hierarchy |
| `/services/tagsservlet.all` | Get all tag categories |
| `/services/tagsservlet.industry` | Get tags in a specific category (e.g., "industry") |
| `/services/tagsservlet.category\|subtag` | Get a specific tag with all translations |
| `/services/tagsservlet.category\|subtag.es` | Get a specific tag in a language (Spanish in this example) |
| `/services/tagsservlet.es` | Get all tags in a specific language |

**Response Format**: JSON

**Implementation Notes**:
- Sample implementation designed for cloud service deployment
- Requires CDN rule configuration to allow traffic to `/services/tagsservlet`
- Filters out internal JCR properties (versions, timestamps, etc.)
- Falls back to English translations when requested language is unavailable

### TagPicker UI

A single-page web application built with vanilla JavaScript that provides an interactive tag selection interface.

**Files**:
- `tagpicker.html` - Structure and markup
- `tagpicker.js` - Core application logic
- `tagpicker.css` - Styling

**Features**:
- **Hierarchical Navigation**: Browse tags organized by category and subcategory
- **Tag Selection**: Click to select individual tags
- **Breadcrumb Display**: Shows the current path through the tag hierarchy
- **Add to List**: Save multiple tags for bulk insertion
- **Reset Function**: Clear all selections and start over
- **Batch Submit**: Insert all selected tags into content at once

**Workflow**:

1. Application loads and fetches tag data from TagsServlet
2. User browses the hierarchical tag menu
3. User clicks on a tag to select it (breadcrumb updates)
4. User clicks "Add Current Tag" to save the selection
5. Selected tags accumulate in the "Saved tags" list
6. User can click any saved tag to remove it
7. User clicks "Insert Tags" to submit all selected tags

**Integration**:
- Uses Adobe Document Services (DA) SDK for CMS integration
- Integrates with the calling application's insert/submit actions
- Sends formatted tag strings back to the parent application

## Configuration

### Prerequisites

- AEM instance with tags configured at `/content/cq:tags`
- CDN rule allowing traffic to `/services/tagsservlet` endpoint
- Sling servlet configuration in your cloud service Java repository

### Setup Steps

1. **Deploy TagsServlet** to your AEM cloud service Java repository
2. **Configure CDN rules** to whitelist `/services/tagsservlet` endpoint
3. **Update tagURL** in `tagpicker.js` to point to your AEM instance:
   ```javascript
   const tagURL = 'https://your-aem-instance.com/services/tagsservlet';
   ```
4. **Host tagpicker files** on your web server or Document Services environment

## Usage

### As an End User

1. Navigate to the Tag Picker interface
2. Click on category names to expand/collapse tag groups
3. Click on individual tags to select them
4. Click "Add Current Tag" to save your selection
5. Repeat steps 2-4 to add multiple tags
6. Review your selections in the "Saved tags" list
7. Click "Insert Tags" to submit all selected tags to your document

### API Usage (TagsServlet)

**Example Requests**:

```bash
# Get all tags
curl https://your-aem-instance.com/services/tagsservlet

# Get all tag categories
curl https://your-aem-instance.com/services/tagsservlet.all

# Get tags in the "industry" category
curl https://your-aem-instance.com/services/tagsservlet.industry

# Get a specific tag with all languages
curl https://your-aem-instance.com/services/tagsservlet.industry|technology

# Get a tag in Spanish
curl https://your-aem-instance.com/services/tagsservlet.industry|technology.es
```

**Example Response** (all tags):
```json
[
  {
    "jcr:title": "Industry",
    "jcr:title.es": "Industria",
    "path": "/content/cq:tags/industry",
    "children": [
      {
        "jcr:title": "Technology",
        "jcr:title.es": "Tecnología",
        "path": "/content/cq:tags/industry/technology",
        "children": []
      }
    ]
  }
]
```

## Supported Languages

The TagsServlet supports the following language codes:
- `en` - English
- `es` - Spanish
- `de` - German
- `fr` - French
- `it` - Italian
- `ja` - Japanese
- `ko` - Korean (maps to `ko_kr`)
- `zh-hans` - Simplified Chinese (maps to `zh_cn`)
- `zh-hant` - Traditional Chinese (maps to `zh_tw`)

## Tag Format

Tags are returned and stored using pipe-delimited notation:
```
category|subcategory|tag
```

Example: `industry|technology|software`

## Troubleshooting

**Tags not loading?**
- Verify the `tagURL` in `tagpicker.js` is correct and accessible
- Check CDN rules allow `/services/tagsservlet` traffic
- Confirm AEM tags exist at `/content/cq:tags`

**Language translations missing?**
- Verify tag properties are properly configured with language-specific titles
- Falls back to English (`jcr:title.en`) or default title (`jcr:title`)

**TagsServlet endpoint returns error?**
- Check that the servlet is deployed and active
- Verify AEM logs for repository exceptions
- Confirm user has read permissions to `/content/cq:tags`

## Security Considerations

- This is a **sample implementation** - not production-ready
- Should be implemented in your cloud service Java repository
- Ensure proper access control on the TagsServlet endpoint
- Consider rate limiting for public endpoints
- Validate and sanitize all tag inputs before using in production

## Development Notes

- Tag display values are normalized by converting to lowercase and replacing spaces with hyphens
- The tool automatically removes the "(intro-stats)-" prefix from tag values
- Ampersands are converted to "and" for URL-safe tag representation
- The breadcrumb tracks the full path through the hierarchy
- Child menus collapse automatically when parent is closed
