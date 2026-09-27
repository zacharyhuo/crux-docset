// Reviewed against Spring Framework's Apache-2.0-licensed source. These are
// exact reference corrections, not heuristics or version-number exceptions.
const local = (id, from, target, fragment, replacement, proof, options = {}) => ({
  id, from, target, fragment, replacement, proof, ...options,
});
const mvc = 'web/webmvc';
const xml = 'core/appendix/xml-custom';
const rest = 'testing/resttestclient';
const suffix = 'web/webmvc/mvc-controller/ann-requestmapping';
export const springReferenceRules = [
  local('mvc-title', ['web', 'languages/kotlin/getting-started', 'core/validation/data-binding', 'core/beans/factory-nature'], mvc, 'mvc', 'page-title', '[[mvc]]\n:chapter: mvc\n[[spring-web-mvc]]\n= Spring Web MVC', { atStart: true }),
  local('webflux-title', ['web-reactive'], 'web/webflux', 'webflux', 'page-title', '[[webflux]]\n:chapter: webflux\n[[spring-webflux]]\n= Spring WebFlux', { atStart: true }),
  local('message-converters-title', ['web/webflux/reactive-spring', 'integration/rest-clients'], 'web/webmvc/message-converters', 'message-converters', 'page-title', '[[message-converters]]\n= HTTP Message Conversion', { atStart: true }),
  local('htmlunit-title', ['testing/mockmvc/htmlunit/mah'], 'testing/mockmvc/htmlunit/why', 'mockmvc-server-htmlunit-why', 'page-title', '[[mockmvc-server-htmlunit-why]]\n= Why HtmlUnit Integration?', { atStart: true }),
  local('jms-title', ['integration/observability'], 'integration/jms/annotated', 'jms-annotated', 'page-title', '[[jms-annotated]]\n= Annotation-driven Listener Endpoints', { atStart: true }),
  ...[['workflow', '=== Built-in Assertions'], ['assertj', '=== AssertJ Integration'], ['json', '==== JSON Content']].map(([part, title]) =>
    local(`resttestclient-${part}`, [rest], rest, `resttestclient-${part}`, `resttestclient.${part}`, `[[resttestclient.${part}]]\n${title}`, { shortReference: true })),
  ...[['schema', '== Authoring the Schema'], ['namespacehandler', '== Coding a `NamespaceHandler`'], ['parser', '== Using `BeanDefinitionParser`'], ['registration', '== Registering the Handler and the Schema'],
    ['introduction', 'Since version 2.0, Spring has featured a mechanism for adding schema-based extensions to the']].map(([part, title]) =>
    local(`xml-custom-${part}`, [xml], xml, `core.appendix.xsd-custom-${part}`, `xsd-custom-${part}`, `[[xsd-custom-${part}]]\n${title}`)),
  local('resttemplate-observability', ['integration/rest-clients'], 'integration/observability', 'http-client.resttemplate', 'observability.http-client.resttemplate', '[[observability.http-client.resttemplate]]\n=== RestTemplate'),
  local('jee-schema', ['data-access/transaction/strategies'], 'integration/appendix', 'xsd-schemas-jee', 'appendix.xsd-schemas-jee', '[[appendix.xsd-schemas-jee]]\n=== The `jee` Schema'),
  local('aop-schema', ['core/aop/schema'], 'core/appendix/xsd-schemas', 'aop', 'xsd-schemas-aop', '[[xsd-schemas-aop]]\n== The `aop` Schema'),
  local('transaction-explanation', ['core/appendix/xsd-schemas'], 'data-access', 'tx-decl-explained', 'page-title', "[[tx-decl-explained]]\n= Understanding the Spring Framework's Declarative Transaction Implementation", {
    atStart: true, destination: 'data-access/transaction/declarative/tx-decl-explained', reference: '<<data-access.adoc#tx-decl-explained,',
  }),
  { id: 'removed-suffix-match', from: ['web/webmvc/mvc-config/content-negotiation', 'web/webflux/config'], target: suffix,
    fragment: 'mvc-ann-requestmapping-suffix-pattern-match', sha256: '521ca233aaa505aa88785c881a6f51331e306ff6a6355a4a0464d4e4e1974724' },
  { id: 'removed-groovy-dsl', from: ['testing/testcontext-framework/ctx-management/groovy'], target: 'core/beans/basics',
    fragment: 'beans-factory-groovy', sha256: '39d6e1ad9f4a0a9e5abc0640903d674bd24d9169d2519c3a9174fccfb786b0eb' },
];
for (const rule of springReferenceRules) { Object.freeze(rule.from); Object.freeze(rule); }
Object.freeze(springReferenceRules);
