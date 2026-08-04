package com.core.servlets;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import javax.json.*;

import org.apache.sling.api.SlingHttpServletRequest;
import org.apache.sling.api.SlingHttpServletResponse;
import org.apache.sling.api.resource.Resource;
import org.apache.sling.api.resource.ResourceResolver;
import org.apache.sling.api.resource.ValueMap;
import org.apache.sling.api.servlets.SlingSafeMethodsServlet;
import org.osgi.framework.Constants;
import org.osgi.service.component.annotations.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import javax.jcr.*;

/**
 * Return information about AEM Tags
 * Please note that this is for sample purposes only. If implementing this,
 * this class belongs in your cloud service Java repo.
 * Also be sure to adjust CDN rules to allow traffic to /services/tagsservlet. 
 */
@Component(immediate=true, service=javax.servlet.Servlet.class,
    property ={Constants.SERVICE_PID + "=com.core.servlets.TagsServlet",
    Constants.SERVICE_DESCRIPTION + "=AEM Tags Servlet",
    "process.label= Get AEM Tags",
    "sling.servlet.paths=/services/tagsservlet",
    "sling.servlet.methods=GET"})
public class TagsServlet extends SlingSafeMethodsServlet {
    
    private static final Logger LOG = LoggerFactory.getLogger(TagsServlet.class);

    private static final String TAGS_PATH = "/content/cq:tags";

    private static final String ENGLISH_TAG_NAME_PROPERTY = "jcr:title.en";

    private static final String[] LANGUAGE_OPTIONS = {"en", "es", "de", "fr", "it", "ja", "ko", "zh-hans", "zh-hant"};

    /* Allow the ability to convert language_country codes to language codes */
    private static final Map<String, String> countryLanguageMappings = new HashMap<String, String>() {{
      put("ko", "ko_kr");
      put("zh-hans", "zh_cn");
      put("zh-hant", "zh_tw");
    }};

    final Set<String> propertiesToIgnore = new HashSet<String>() {{
      add("cq:tags");
      add("cq:tags_xmpArrayType");
      add("dc:creator");
      add("dc:creator_xmpArrayType");
      add("jcr:created");
      add("jcr:createdBy");
      add("jcr:versionHistory");
      add("jcr:predecessors");
      add("jcr:baseVersion");
      add("jcr:uuid");
      add("jcr:primaryType");
      add("jcr:lastModifiedBy");
      add("jcr:lastModified");
      add("jcr:mixinTypes");
      add("sling:resourceType");
    }};
    
    /**
     * If no . then display all tags (/services/tagsservlet)
     * if .  without :, then it is getting all tags in a category (/services/tagsservlet.industry)
     * if . with :, then get a specific tag with all translations.
     * if . with : and then a second ., get the language specific version of tag
     **/
    @Override
    protected void doGet(SlingHttpServletRequest request, SlingHttpServletResponse response) throws IOException {
      response.setCharacterEncoding("UTF-8");
      response.setContentType("application/json");
      LOG.debug("in doGet");

      ResourceResolver resolver = request.getResourceResolver();
      String requestUrl = request.getPathInfo();
      LOG.debug(requestUrl);
      try {
        if(requestUrl.contains(".")) {
          String[] selectors = requestUrl.split("\\.");
          LOG.debug(Arrays.toString(selectors));
          LOG.debug("Found: " + selectors.length);
          if (selectors.length == 2) {
            //Grab the selector portion, not path.
            String tagString = selectors[1];
             if (tagString.contains("|")) {
              //get an individual tag.
              response.getWriter().write(getTagByName(resolver, tagString).toString());
            } else {
              // get the tag category.
              LOG.debug("get tag category");
              LOG.debug(tagString);
              if (tagString.equalsIgnoreCase("all")) {
                response.getWriter().write(getAllTagCategories(resolver).toString());
              } else if (Arrays.asList(LANGUAGE_OPTIONS).contains(tagString.toLowerCase())) {
                response.getWriter().write(getTagsByLanguage(resolver, tagString).toString());
              } else {
                JsonArray tagArray = getTagsByCategory(resolver, tagString);
                response.getWriter().write(tagArray.toString());
              }
            }
          } else if (selectors.length == 3) {
            //get the language version.
            String tagString = selectors[1];
            String languageCode = selectors[2];
            response.getWriter().write(getTranslatedTagValue(resolver, tagString, languageCode));
          } else {
            response.getWriter().write("Error: Invalid Request");
          }
        } else {
          //get all tags
          LOG.debug("no . so get all tag information");
          JsonArray tagArray = getAllTags(resolver);
          String tagArrayString = tagArray != null ? tagArray.toString() : "";
          response.getWriter().write(tagArrayString);

        }
      } catch(RepositoryException e) {
        LOG.error(e.getMessage());
        response.getWriter().write("ERROR: " + e.getMessage());
      }
  }

  private JsonObject convertNodeToJsonObject(Node node) throws RepositoryException {
    LOG.debug(node.getPath());
    JsonObjectBuilder builder = Json.createObjectBuilder();
    PropertyIterator propertyIterator = node.getProperties();
    while (propertyIterator.hasNext()) {
      Property property = propertyIterator.nextProperty();
      if (propertiesToIgnore == null || propertiesToIgnore.isEmpty() || !propertiesToIgnore.contains(property.getName())) {
        try {
          if (property.getValue() != null)
            builder.add(property.getName(), property.getValue().getString());
          else
            builder.add(property.getName(), "");
        } catch (Exception e) {
          LOG.error("Problem with property " + property.getName() + " : " + e.getMessage());
        }
      }
    }
    builder.add("path", node.getPath());

    NodeIterator childNodes = node.getNodes();
    if (childNodes != null && childNodes.hasNext()) {
      builder.add("children", createArrayOfObjects(node));
    }
    return builder.build();
  }

  private JsonArray createArrayOfObjects(Node node) throws RepositoryException {
    JsonArray array = null;

    if (node != null) {
      LOG.debug(node.getPath());
      JsonArrayBuilder arrayBuilder = Json.createArrayBuilder();
      NodeIterator nodeIterator = node.getNodes();

      while (nodeIterator.hasNext()) {
        Node currentNode = nodeIterator.nextNode();

        if (currentNode.getProperty("jcr:primaryType").getString().equalsIgnoreCase("cq:Tag")) {
          JsonObject obj = convertNodeToJsonObject(currentNode);
          if (obj != null) {
            arrayBuilder.add(obj);
          }
        }
      }
      array = arrayBuilder.build();
    }
    return array;
  }

  private JsonArray getAllTags(ResourceResolver resolver) throws RepositoryException {
    Resource resource = resolver.getResource(TAGS_PATH);
    Node node = resource.adaptTo(Node.class);
    return createArrayOfObjects(node);
  }
  
  private JsonArray getAllTagCategories(ResourceResolver resolver) {
    Resource resource = resolver.getResource(TAGS_PATH);
    JsonArrayBuilder builder = Json.createArrayBuilder();
    LOG.debug(resource.getPath());
    for (Resource child : resource.getChildren()) {
      if (child != null) {
        ValueMap map = child.getValueMap();
        LOG.debug(map.get("jcr:title", String.class));
        builder.add(map.get("jcr:title", String.class));
      }
    }
    return builder.build();
  }

  private JsonArray getTagsByCategory(ResourceResolver resolver, String tagCategory) throws RepositoryException {
    String  categoryPath = TAGS_PATH.concat("/").concat(tagCategory.toLowerCase());
    Resource resource = resolver.getResource(categoryPath);
    if (resource == null) {
      throw new RepositoryException("Invalid Tag Catgegory");
    }
    JsonArrayBuilder builder = Json.createArrayBuilder();
    LOG.debug(resource.getPath());
    for (Resource child : resource.getChildren()) {
      if (child != null) {
        ValueMap map = child.getValueMap();
        LOG.debug(map.get("jcr:title", String.class));
        builder.add(map.get("jcr:title", String.class));
      }
    }
    return  builder.build();
  }

  private JsonObject getTagByName(ResourceResolver resolver, String tagString) throws RepositoryException {
    String tagPath = TAGS_PATH.concat("/").concat(tagString.replace("|", "/"));
    LOG.debug("Tag Path: " + tagPath);
    Resource resource = resolver.getResource(tagPath);
    if (resource == null) {
      throw new RepositoryException("Invalid Tag Name");
    }
    Node node = resource.adaptTo(Node.class);
    return convertNodeToJsonObject(node);
  }

  private String getTranslatedTagValue(ResourceResolver resolver, String tagString, String languageCode) throws RepositoryException {
    String tagPath = TAGS_PATH.concat("/").concat(tagString.replace("|", "/"));
    LOG.debug("Tag Path: " + tagPath);
    LOG.debug("languageCode " + languageCode);
    Resource resource = resolver.getResource(tagPath);
    if (resource == null) {
      throw new RepositoryException("Invalid Tag Name");
    }
    ValueMap map = resource.getValueMap();
    String languageKey = "jcr:title.".concat(languageCode);
    if (map.containsKey(languageKey)) {
      return map.get(languageKey, String.class);
    } else if (map.containsKey(ENGLISH_TAG_NAME_PROPERTY)) {
      return map.get(ENGLISH_TAG_NAME_PROPERTY, String.class);
    }
    return map.get("jcr:title", String.class);
  }

  private static void traverse(Node node, String languageCode, String prefixString, Map<String, String> map) throws RepositoryException{
    if (node == null) {
      return;
    }

    String languageKey = "jcr:title.".concat(languageCode);
    String defaultEnglishKey = "jcr:title.en";
    String defaultKey = "jcr:title";
    String name = node.getName();

    String value = null;
    if (node.hasProperty(languageKey)) {
      value = node.getProperty(languageKey).getString();
    } else if (node.hasProperty(defaultEnglishKey)) {
      value = node.getProperty(defaultEnglishKey).getString();
    } else {
      value = node.getProperty(defaultKey).getString();
    }

    String newPrefix = prefixString.concat(name);
    map.put(newPrefix, value);
    newPrefix = newPrefix.concat("|");

    NodeIterator children = node.getNodes();
    while (children.hasNext()) {
      traverse(children.nextNode(), languageCode, newPrefix, map);
    }
  }

  private JsonObject getTagsByLanguage(ResourceResolver resolver, String languageCode) throws RepositoryException {
    Resource resource = resolver.getResource(TAGS_PATH);
    Node node = resource.adaptTo(Node.class);
    if (countryLanguageMappings.containsKey(languageCode)) {
      languageCode = countryLanguageMappings.get(languageCode);
    }

    Map<String, String> mapObj = new HashMap<>();
    NodeIterator children = node.getNodes();
    while(children.hasNext()) {
      traverse(children.nextNode(), languageCode, "", mapObj);
    }

    JsonObjectBuilder builder = Json.createObjectBuilder();
    for (Map.Entry<String, String> entry : mapObj.entrySet()) {
      builder.add(entry.getKey(), entry.getValue());
    }
    return builder.build();
  }
}