// @ts-check
'use strict';

const fs = require('fs');
const url = require('url');
const URL = url.URL;
const util = require('util');

const yaml = require('js-yaml');
const should = require('should');
let ajv = require('ajv')({
    allErrors: true,
    verbose: true,
    jsonPointers: true,
    patternGroups: true,
    extendRefs: true // optional, current default is to 'fail', spec behaviour is to 'ignore'
});
//meta: false, // optional, to prevent adding draft-06 meta-schema

let ajvFormats = require('ajv/lib/compile/formats.js');
ajv.addFormat('uriref', ajvFormats.full['uri-reference']);
ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
ajv._refs['http://json-schema.org/schema'] = 'http://json-schema.org/draft-04/schema'; // optional, using unversioned URI is out of spec
let metaSchema = require('ajv/lib/refs/json-schema-v5.json');
ajv.addMetaSchema(metaSchema);
ajv._opts.defaultMeta = metaSchema.id;

const bae = require('better-ajv-errors');

class JSONSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JSONSchemaError';
  }
};

class CLIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CLIError';
  }
};

const common = require('oas-kit-common');
const jptr = require('reftools/lib/jptr.js');
const resolveInternal = jptr.jptr;
const clone = require('reftools/lib/clone.js').clone;
const recurse = require('reftools/lib/recurse.js').recurse;
const isRef = require('reftools/lib/isref.js').isRef;
const sw = require('oas-schema-walker');
const linter = require('oas-linter');
const resolver = require('oas-resolver');

const jsonSchema = require('./schemas/json_v5.json');
const validateMetaSchema = ajv.compile(jsonSchema);
let openapi3Schema = require('./schemas/openapi-3.0.json');
let validateOpenAPI3 = ajv.compile(openapi3Schema);

const dummySchema = { anyOf: {} };
const emptySchema = {};
const urlRegexStr = '^(?!mailto:)(?:(?:http|https|ftp)://)(?:\\S+(?::\\S*)?@)?(?:(?:(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])(?:\\.(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}(?:\\.(?:[0-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]))|(?:(?:[a-z\\u00a1-\\uffff0-9]+-?)*[a-z\\u00a1-\\uffff0-9]+)(?:\\.(?:[a-z\\u00a1-\\uffff0-9]+-?)*[a-z\\u00a1-\\uffff0-9]+)*(?:\\.(?:[a-z\\u00a1-\\uffff]{2,})))|localhost)(?::\\d{2,5})?(?:(/|\\?|#)[^\\s]*)?$';
const urlRegex = new RegExp(urlRegexStr, 'i');

function contextAppend(options, s) {
    options.context.push((options.context[options.context.length - 1] + '/' + s).split('//').join('/'));
}

function validateUrl(s, contextServers, context, options) {
    should(s).be.a.String();
    s.should.not.be.Null();
    if (!options.laxurls) s.should.not.be.exactly('', 'Invalid empty URL ' + context);
    let base = options.origin || 'http://localhost/';
    if (contextServers && contextServers.length) {
        let servers = contextServers[0];
        if (servers && servers.length) {
            base = servers[0].url;
        }
    }
    if (s.indexOf('://') > 0) { // FIXME HACK
        base = undefined;
    }
    //s.should.match(urlRegex); // doesn't allow for templated urls
    let u = (URL && options.whatwg) ? new URL(s, base) : url.parse(s);
    return true; // if we haven't thrown
}

function validateComponentName(name) {
    return /^[a-zA-Z0-9\.\-_]+$/.test(name);
}

function validateHeaderName(name) {
    return /^[A-Za-z0-9!#\-\$%&'\*\+\\\.\^_`\|~]+$/.test(name);
}

function validateSchema(schema, openapi, options) {
    validateMetaSchema(schema);
    let errors = validateSchema.errors;
    if (errors && errors.length) {
        if (options.prettify) {
            const errorStr = bae(schema, openapi, errors);
            throw (new CLIError(errorStr));
        }
        throw (new JSONSchemaError('Schema invalid: ' + util.inspect(errors)));
    }
    options.schema = schema;
    return !(errors && errors.length);
}

function checkSubSchema(schema, parent, state) {
    let prop = state.property;
    if (prop) contextAppend(state.options, prop);
    if (state.options.lint) state.options.linter('schema',schema,'schema',state.options);
    schema.should.be.an.Object();
    schema.should.not.be.an.Array();

    if (typeof schema.$ref !== 'undefined') {
        should(schema.$ref).be.a.String();
        if (state.options.lint) state.options.linter('reference',schema,'$ref',state.options);
        if (prop) state.options.context.pop();
        return; // all other properties SHALL be ignored
    }

    for (let k in schema) {
        if (!k.startsWith('x-')) {
            should(['type','items','format','properties','required','minimum','maximum',
            'exclusiveMinimum','exclusiveMaximum','enum','default','description','title',
            'readOnly','writeOnly','anyOf','allOf','oneOf','not','discriminator','maxItems',
            'minItems','additionalItems','additionalProperties','example','maxLength',
            'minLength','pattern','uniqueItems','xml','externalDocs','nullable','deprecated',
            'minProperties','maxProperties','multipleOf'].indexOf(k)).
            be.greaterThan(-1,'Schema object cannot have additionalProperty: '+k);
        }
    }

    if (typeof schema.multipleOf !== 'undefined') {
        should(schema.multipleOf).be.type('number','multipleOf must be a number');
        schema.multipleOf.should.be.greaterThan(0);
    }
    if (typeof schema.maximum !== 'undefined') {
        should(schema.maximum).be.type('number','maximum must be a number');
    }
    if (typeof schema.exclusiveMaximum !== 'undefined') {
        should(schema.exclusiveMaximum).be.type('boolean','exclusiveMaximum must be a boolean');
    }
    if (typeof schema.minimum !== 'undefined') {
        should(schema.minimum).be.type('number','minimum must be a number');
    }
    if (typeof schema.exclusiveMinimum !== 'undefined') {
        should(schema.exclusiveMinimum).be.type('boolean','exclusiveMinimum must be a boolean');
    }
    if (typeof schema.maxLength !== 'undefined') {
        should(schema.maxLength).be.type('number','maxLength must be a number');
        schema.maxLength.should.be.greaterThan(-1);
    }
    if (typeof schema.minLength !== 'undefined') {
        should(schema.minLength).be.type('number','minLength must be a number');
        schema.minLength.should.be.greaterThan(-1);
    }
    if (schema.pattern) {
        try {
            let regex = new RegExp(schema.pattern);
        }
        catch (ex) {
            should.fail(false,true,'pattern does not conform to ECMA-262');
        }
    }
    if (typeof schema.items !== 'undefined') {
        should(schema.items).be.an.Object();
        schema.items.should.not.be.an.Array();
    }
    if (schema.additionalItems) {
        if (typeof schema.additionalItems === 'boolean') {
        }
        else if (typeof schema.additionalItems === 'object') {
            schema.additionalItems.should.not.be.an.Array();
        }
        else should.fail(false,true,'additionalItems must be a boolean or schema');
    }
    if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === 'boolean') {
        }
        else if (typeof schema.additionalProperties === 'object') {
            schema.additionalProperties.should.not.be.an.Array();
        }
        else should.fail(false,true,'additionalProperties must be a boolean or schema');
    }
    if (typeof schema.maxItems !== 'undefined') {
        should(schema.maxItems).be.type('number','maxItems must be a number');
        schema.maxItems.should.be.greaterThan(-1);
    }
    if (typeof schema.minItems !== 'undefined') {
        should(schema.minItems).be.type('number','minItems must be a number');
        schema.minItems.should.be.greaterThan(-1);
    }
    if (typeof schema.uniqueItems !== 'undefined') {
        should(schema.uniqueItems).be.type('boolean','uniqueItems must be a boolean');
    }
    if (typeof schema.maxProperties !== 'undefined') {
        should(schema.maxProperties).be.type('number','maxProperties must be a number');
        schema.maxProperties.should.be.greaterThan(-1);
    }
    if (typeof schema.minProperties !== 'undefined') {
        should(schema.minProperties).be.type('number','minProperties must be a number');
        schema.minProperties.should.be.greaterThan(-1);
    }
    if (typeof schema.required !== 'undefined') {
        should(schema.required).be.an.Array();
        schema.required.should.not.be.empty();
        common.hasDuplicates(schema.required).should.be.exactly(false,'required items must be unique');
    }
    if (schema.properties) {
        schema.properties.should.be.an.Object();
        schema.properties.should.not.be.an.Array();
    }
    schema.should.not.have.property('patternProperties');
    /*if (schema.patternProperties) {
        schema.patternProperties.should.be.an.Object();
        for (let prop in schema.patternProperties) {
            try {
                let regex = new RegExp(prop);
            }
            catch (ex) {
                should.fail(false,true,'patternProperty '+prop+' does not conform to ECMA-262');
            }
        }
    }*/
    if (typeof schema.enum !== 'undefined') {
        should(schema.enum).be.an.Array();
        schema.enum.should.not.be.empty();
        // items only SHOULD be unique
    }
    if (typeof schema.type !== 'undefined') {
        should(schema.type).be.a.String(); // not an array
        schema.type.should.equalOneOf('integer','number','string','boolean','object','array'); // not null
        if (schema.type === 'array') {
            schema.should.have.property('items');
        }
    }
    if (schema.allOf) {
        schema.allOf.should.be.an.Array();
        schema.allOf.should.not.be.empty();
    }
    if (schema.anyOf) {
        schema.anyOf.should.be.an.Array();
        schema.anyOf.should.not.be.empty();
    }
    if (schema.oneOf) {
        schema.oneOf.should.be.an.Array();
        schema.oneOf.should.not.be.empty();
    }
    if (schema.not) {
        schema.not.should.be.an.Object();
        schema.not.should.not.be.an.Array();
    }
    if (typeof schema.title !== 'undefined') {
        should(schema.title).be.a.String();
    }
    if (typeof schema.description !== 'undefined') {
        should(schema.description).be.a.String();
    }
    if (typeof schema.default !== 'undefined') {
        schema.should.have.property('type');
        let realType = typeof schema.default;
        let schemaType = schema.type;
        if (Array.isArray(schema.default)) realType = 'array';
        if (schemaType === 'integer') schemaType = 'number';
        schemaType.should.equal(realType);
    }
    if (typeof schema.format !== 'undefined') {
        should(schema.format).be.a.String();
        if (schema.type && ['date-time','email','hostname','ipv4','ipv6','uri','uriref',
            'byte','binary','date','password'].indexOf(schema.format) >= 0) {
            schema.type.should.equal('string',`Invalid type ${schema.type} for format ${schema.format}`);
        }
        if (schema.type && ['int32','int64'].indexOf(schema.format) >= 0) {
            if (schema.type !== 'string' && schema.type !== 'number') { // common case - googleapis
               schema.type.should.equal('integer',`Invalid type ${schema.type} for format ${schema.format}`);
            }
        }
        if (schema.type && ['float','double'].indexOf(schema.format) >= 0) {
            if (schema.type !== 'string') { // occasionally seen
                schema.type.should.equal('number',`Invalid type ${schema.type} for format ${schema.format}`);
            }
        }
    }

    if (typeof schema.nullable !== 'undefined') {
        should(schema.nullable).be.type('boolean','nullable must be a boolean');
    }
    if (typeof schema.readOnly !== 'undefined') {
        should(schema.readOnly).be.type('boolean','readOnly must be a boolean');
        schema.should.not.have.property('writeOnly');
    }
    if (typeof schema.writeOnly !== 'undefined') {
        should(schema.writeOnly).be.type('boolean','writeOnly must be a boolean');
        schema.should.not.have.property('readOnly');
    }
    if (typeof schema.deprecated !== 'undefined') {
        should(schema.deprecated).be.type('boolean','deprecated must be a boolean');
    }
    if (typeof schema.discriminator !== 'undefined') {
        should(schema.discriminator).be.an.Object();
        schema.discriminator.should.not.be.an.Array();
        schema.discriminator.should.have.property('propertyName');
        //"To avoid redundancy, the discriminator MAY be added to a parent schema definition..."
        //if ((Object.keys(parent).length>0) && !(parent.oneOf || parent.anyOf || parent.allOf)) {
        //    should.fail(false,true,'discriminator requires oneOf, anyOf or allOf in parent schema');
        //}
    }
    if (typeof schema.xml !== 'undefined') {
        should(schema.xml).be.an.Object();
        schema.xml.should.not.be.an.Array();
    }
    // example can be any type

    if (typeof schema.externalDocs !== 'undefined') {
        should(schema.externalDocs).be.an.Object();
        schema.externalDocs.should.not.be.an.Array();
        schema.externalDocs.should.have.key('url');
        should.doesNotThrow(function() { validateUrl(schema.externalDocs.url, [state.openapi.servers], 'externalDocs', state.options)}, 'Invalid externalDocs.url');
        if (state.options.lint) state.options.linter('externalDocs',schema.externalDocs,'externalDocs',state.options);
    }
    if (prop) state.options.context.pop();
    if (!prop || prop === 'schema') validateSchema(schema, state.openapi, state.options); // top level only
}

function checkSchema(schema,parent,prop,openapi,options) {
    let state = sw.getDefaultState();
    state.openapi = openapi;
    state.options = options;
    state.property = prop;
    sw.walkSchema(schema,parent,state,checkSubSchema);
}

function checkExample(ex, contextServers, openapi, options) {
    ex.should.be.an.Object();
    ex.should.not.be.an.Array();
    if (typeof ex.summary !== 'undefined') {
        should(ex.summary).have.type('string');
    }
    if (typeof ex.description !== 'undefined') {
        should(ex.description).have.type('string');
    }
    if (typeof ex.value !== 'undefined') {
        ex.should.not.have.property('externalValue');
    }
    //else { // not mandated by the spec. moved to linter rule
    //    ex.should.have.property('externalValue');
    //}
    if (typeof ex.externalValue !== 'undefined') {
        ex.should.not.have.property('value');
        should.doesNotThrow(function () { validateUrl(ex.externalValue, contextServers, 'examples..externalValue', options) },'Invalid examples..externalValue');
    }
    //else { // not mandated by the spec. moved to linter rule
    //    ex.should.have.property('value');
    //}
    for (let k in ex) {
        if (!k.startsWith('x-')) {
            should(['summary','description','value','externalValue'].indexOf(k)).be.greaterThan(-1,'Example object cannot have additionalProperty: '+k);
        }
    }
    if (options.lint) options.linter('example',ex,'example',options);
}

function checkContent(content, contextServers, openapi, options) {
    contextAppend(options, 'content');
    content.should.be.an.Object();
    content.should.not.be.an.Array();
    for (let ct in content) {
        contextAppend(options, jptr.jpescape(ct));
        // validate ct against https://tools.ietf.org/html/rfc6838#section-4.2
        if (options.mediatype) {
            should(/[a-zA-Z0-9!#$%^&\*_\-\+{}\|'.`~]+\/[a-zA-Z0-9!#$%^&\*_\-\+{}\|'.`~]+/.test(ct)).be.exactly(true,'media-type should match RFC6838 format'); // this is a SHOULD not MUST
        }
        let contentType = content[ct];
        should(contentType).be.an.Object();
        should(contentType).not.be.an.Array();

        if (typeof contentType.schema !== 'undefined') {
            checkSchema(contentType.schema,emptySchema,'schema',openapi,options);
        }
        if (typeof contentType.example !== 'undefined') {
            contentType.should.not.have.property('examples');
        }
        if (typeof contentType.examples !== 'undefined') {
            contextAppend(options, 'examples');
            contentType.should.not.have.property('example');
            should(contentType.examples).be.an.Object();
            contentType.examples.should.not.be.an.Array();
            for (let e in contentType.examples) {
                let ex = contentType.examples[e];
                if (typeof ex.$ref !== 'undefined') {
                    if (options.lint) options.linter('reference',ex,'$ref',options);
                }
                else {
                    checkExample(ex, contextServers, openapi, options);
                }
            }
            options.context.pop();
        }

        for (let k in contentType) {
            if (!k.startsWith('x-')) {
                should(['schema','example','examples','encoding'].indexOf(k)).be.greaterThan(-1,'mediaType object cannot have additionalProperty: '+k);
            }
        }
        options.context.pop();
    }
    options.context.pop();
}

function checkServer(server, options) {
    server.should.have.property('url');
    should.doesNotThrow(function () { validateUrl(server.url, [], 'server.url', options) },'Invalid server.url');
    if (typeof server.description !== 'undefined') {
        should(server.description).be.a.String();
    }
    let srvVars = 0;
    server.url.replace(/\{(.+?)\}/g, function (match, group1) {
        srvVars++;
        server.should.have.key('variables');
        server.variables.should.have.key(group1);
    });
    if (typeof server.variables !== 'undefined') {
        contextAppend(options, 'variables');
        should(server.variables).be.an.Object();
        server.variables.should.not.be.an.Array();
        for (let v in server.variables) {
            contextAppend(options, v);
            should(server.variables[v]).be.an.Object();
            server.variables[v].should.have.key('default');
            should(server.variables[v].default).be.a.String();
            if (typeof server.variables[v].enum !== 'undefined') {
                contextAppend(options, 'enum');
                should(server.variables[v].enum).be.an.Array();
                should(server.variables[v].enum.length).not.be.exactly(0, 'Server variables enum should not be empty');
                for (let e in server.variables[v].enum) {
                    contextAppend(options, e);
                    should(server.variables[v].enum[e]).be.type('string');
                    options.context.pop();
                }
                options.context.pop();
            }
            if (options.lint) options.linter('serverVariable',server.variables[v],v,options);
            options.context.pop();
        }
        should(Object.keys(server.variables).length).be.exactly(srvVars);
        options.context.pop();
    }
    if (options.lint) options.linter('server',server,'server',options);
}

function checkServers(servers, options) {
    should(servers).be.an.Array();
    //common.distinctArray(servers).should.be.exactly(true,'servers array must be distinct'); // TODO move to linter
    for (let s in servers) {
        contextAppend(options, s);
        let server = servers[s];
        checkServer(server, options);
        options.context.pop();
    }
}

function checkLink(link, openapi, options) {
    if (typeof link.$ref !== 'undefined') {
        let ref = link.$ref;
        should(link.$ref).be.type('string');
        if (options.lint) options.linter('reference',link,'$ref',options);
        link = resolveInternal(openapi, ref);
        should(link).not.be.exactly(false, 'Cannot resolve reference: ' + ref);
    }
    link.should.be.type('object');
    if (typeof link.operationRef === 'undefined') {
        link.should.have.property('operationId');
    }
    else {
        link.operationRef.should.be.type('string');
        link.should.not.have.property('operationId');
    }
    if (typeof link.operationId === 'undefined') {
        link.should.have.property('operationRef');
    }
    else {
        link.operationId.should.be.type('string');
        link.should.not.have.property('operationRef');
        // validate operationId exists (external refs?)
    }
    if (typeof link.parameters != 'undefined') {
        link.parameters.should.be.type('object');
        link.parameters.should.not.be.an.Array();
    }
    if (typeof link.description !== 'undefined') {
        should(link.description).have.type('string');
    }
    if (typeof link.server !== 'undefined') {
        checkServer(link.server, options);
    }
    if (options.lint) options.linter('link',link,'link',options);
}

function checkHeader(header, contextServers, openapi, options) {
    if (typeof header.$ref !== 'undefined') {
        let ref = header.$ref;
        should(header.$ref).be.type('string');
        if (options.lint) options.linter('reference',header,'$ref',options);
        header = resolveInternal(openapi, ref);
        should(header).not.be.exactly(false, 'Cannot resolve reference: ' + ref);
    }
    header.should.not.have.property('name');
    header.should.not.have.property('in');
    header.should.not.have.property('type');
    for (let prop of common.parameterTypeProperties) {
        header.should.not.have.property(prop);
    }
    if (typeof header.schema !== 'undefined') {
        header.should.not.have.property('content');
        if (typeof header.style !== 'undefined') {
            should(header.style).be.type('string');
            header.style.should.be.exactly('simple');
        }
        if (typeof header.explode !== 'undefined') {
            should(header.explode).be.type('boolean');
        }
        if (typeof header.allowReserved !== 'undefined') {
            should(header.allowReserved).be.type('boolean');
        }
        checkSchema(header.schema, emptySchema, 'schema', openapi, options);
    }
    if (header.content) {
        header.should.not.have.property('schema');
        header.should.not.have.property('style');
        header.should.not.have.property('explode');
        header.should.not.have.property('allowReserved');
        header.should.not.have.property('example');
        header.should.not.have.property('examples');
        checkContent(header.content, contextServers, openapi, options);
    }
    if (!header.schema && !header.content) {
        header.should.have.property('schema', 'Header should have schema or content');
    }
    if (options.lint) options.linter('header',header,'header',options);
}

function checkResponse(response, contextServers, openapi, options) {
    should(response).not.be.null();
    if (typeof response.$ref !== 'undefined') {
        let ref = response.$ref;
        should(response.$ref).be.type('string');
        if (options.lint) options.linter('reference',response,'$ref',options);
        response = resolveInternal(openapi, ref);
        should(response).not.be.exactly(false, 'Cannot resolve reference: ' + ref);
    }
    response.should.have.property('description');
    should(response.description).have.type('string', 'response description should be of type string');
    response.should.not.have.property('examples');
    response.should.not.have.property('schema');
    if (response.headers) {
        contextAppend(options, 'headers');
        for (let h in response.headers) {
            contextAppend(options, h);
            validateHeaderName(h).should.be.equal(true, 'Header doesn\'t match RFC7230 pattern');
            checkHeader(response.headers[h], contextServers, openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }

    if (response.content) {
        checkContent(response.content, contextServers, openapi, options);
    }

    if (typeof response.links !== 'undefined') {
        contextAppend(options, 'links');
        for (let l in response.links) {
            contextAppend(options, l);
            checkLink(response.links[l], openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }
    if (options.lint) options.linter('response',response,'response',options);
}

function checkParam(param, index, path, contextServers, openapi, options) {
    contextAppend(options, index);
    if (typeof param.$ref !== 'undefined') {
        should(param.$ref).be.type('string');
        if (options.lint) options.linter('reference',param,'$ref',options);
        let ref = param.$ref;
        param = resolveInternal(openapi, ref);
        should(param).not.be.exactly(false, 'Cannot resolve reference: ' + ref);
    }
    param.should.have.property('name');
    param.name.should.have.type('string');
    param.should.have.property('in');
    param.in.should.have.type('string');
    param.in.should.equalOneOf('query', 'header', 'path', 'cookie');
    if (param.in === 'path') {
        param.should.have.property('required');
        param.required.should.be.exactly(true, 'Path parameters must have an explicit required:true');
        if (path) { // if we're not looking at a param from #/components (checked when used)
            should(path.indexOf('{'+param.name+'}')).be.greaterThan(-1,'path parameters must appear in the path');
        }
    }
    if (typeof param.required !== 'undefined') should(param.required).have.type('boolean');
    param.should.not.have.property('items');
    param.should.not.have.property('collectionFormat');
    param.should.not.have.property('type');
    for (let prop of common.parameterTypeProperties) {
        param.should.not.have.property(prop);
    }
    param.in.should.not.be.exactly('body', 'Parameter type body is no-longer valid');
    param.in.should.not.be.exactly('formData', 'Parameter type formData is no-longer valid');
    if (param.description) {
        param.description.should.have.type('string');
    }
    if (typeof param.deprecated !== 'undefined') {
        should(param.deprecated).be.a.Boolean();
    }
    if (typeof param.schema !== 'undefined') {
        param.should.not.have.property('content');
        if (typeof param.style !== 'undefined') {
            should(param.style).be.type('string');
            if (param.in === 'path') {
                param.style.should.not.be.exactly('form');
                param.style.should.not.be.exactly('spaceDelimited');
                param.style.should.not.be.exactly('pipeDelimited');
                param.style.should.not.be.exactly('deepObject');
            }
            if (param.in === 'query') {
                param.style.should.not.be.exactly('matrix');
                param.style.should.not.be.exactly('label');
                param.style.should.not.be.exactly('simple');
            }
            if (param.in === 'header') {
                param.style.should.be.exactly('simple');
            }
            if (param.in === 'cookie') {
                param.style.should.be.exactly('form');
            }
        }
        if (typeof param.explode !== 'undefined') {
            should(param.explode).be.type('boolean');
        }
        if (typeof param.allowReserved !== 'undefined') {
            should(param.allowReserved).be.type('boolean');
        }
        if (typeof param.example !== 'undefined') {
            param.should.not.have.key('examples');
        }
        if (typeof param.examples !== 'undefined') {
            contextAppend(options, 'examples');
            param.should.not.have.key('example');
            should(param.examples).be.an.Object();
            param.examples.should.not.be.an.Array();
            for (let e in param.examples) {
                contextAppend(options, e);
                let example = param.examples[e];
                checkExample(example, contextServers, openapi, options);
                options.context.pop();
            }
            options.context.pop();
        }
        checkSchema(param.schema, emptySchema, 'schema', openapi, options);
    }
    if (param.content) {
        param.should.not.have.property('schema');
        param.should.not.have.property('style');
        param.should.not.have.property('explode');
        param.should.not.have.property('allowReserved');
        param.should.not.have.property('example');
        param.should.not.have.property('examples');
        should(Object.keys(param.content).length).be.exactly(1, 'Parameter content must have only one entry');
        checkContent(param.content, contextServers, openapi, options);
    }
    if (!param.schema && !param.content) {
        param.should.have.property('schema', 'Parameter should have schema or content');
    }
    if (options.lint) options.linter('parameter',param,index,options);
    options.context.pop();
    return param;
}

function checkPathItem(pathItem, path, openapi, options) {

    should(pathItem).be.an.Object();
    pathItem.should.not.be.an.Array();

    let contextServers = [];
    contextServers.push(openapi.servers);
    if (pathItem.servers) contextServers.push(pathItem.servers);

    let pathParameters = {};
    if (typeof pathItem.parameters !== 'undefined') should(pathItem.parameters).be.an.Array();
    for (let p in pathItem.parameters) {
        contextAppend(options, 'parameters');
        let param = checkParam(pathItem.parameters[p], p, path, contextServers, openapi, options);
        if (pathParameters[param.in+':'+param.name]) {
            should.fail(false,true,'Duplicate path-level parameter '+param.name);
        }
        else {
            pathParameters[param.in+':'+param.name] = param;
        }
        options.context.pop();
    }

    for (let o in pathItem) {
        contextAppend(options, o);
        let op = pathItem[o];
        if (o === '$ref') {
            should(op).be.ok();
            op.should.have.type('string');
            should(op.startsWith('#/')).equal(false,'PathItem $refs must be external ('+op+')');
            if (options.lint) options.linter('reference',pathItem,'$ref',options);
        }
        else if (o === 'parameters') {
            // checked above
        }
        else if (o === 'servers') {
            contextAppend(options, 'servers');
            checkServers(op, options); // won't be here in converted definitions
            options.context.pop();
        }
        else if (o === 'summary') {
            should(pathItem.summary).have.type('string');
        }
        else if (o === 'description') {
            should(pathItem.description).have.type('string');
        }
        else if (common.httpMethods.indexOf(o) >= 0) {
            should(op).be.an.Object();
            op.should.not.be.an.Array();
            op.should.not.have.property('consumes');
            op.should.not.have.property('produces');
            op.should.not.have.property('schemes');
            op.should.have.property('responses');
            should(op.responses).be.an.Object();
            op.responses.should.not.be.an.Array();
            op.responses.should.not.be.empty();
            if (op.summary) op.summary.should.have.type('string');
            if (typeof op.description !== 'undefined') should(op.description).be.a.String();
            if (typeof op.operationId !== 'undefined') {
                should(op.operationId).be.a.String();
                should(options.operationIds.indexOf(op.operationId)).be.exactly(-1,'operationIds must be unique');
                options.operationIds.push(op.operationId);
            }

            if (typeof op.servers !== 'undefined') {
                contextAppend(options, 'servers');
                checkServers(op.servers, options); // won't be here in converted definitions
                options.context.pop();
                contextServers.push(op.servers);
            }

            if (typeof op.tags !== 'undefined') {
                contextAppend(options, 'tags');
                should(op.tags).be.an.Array();
                for (let tag of op.tags) {
                    tag.should.be.a.String();
                }
                options.context.pop();
            }

            if (typeof op.requestBody !== 'undefined') {
                contextAppend(options, 'requestBody');
                should(op.requestBody).not.be.null();
                op.requestBody.should.be.an.Object();
                op.requestBody.should.not.be.an.Array();
                if (typeof op.requestBody.description !== 'undefined') should(op.requestBody.description).have.type('string');
                if (typeof op.requestBody.required !== 'undefined') should(op.requestBody.required).have.type('boolean');
                if (typeof op.requestBody.content !== 'undefined') {
                    checkContent(op.requestBody.content, contextServers, openapi, options);
                }
                options.context.pop();
            }

            contextAppend(options, 'responses');
            for (let r in op.responses) {
                if (!r.startsWith('x-')) {
                    contextAppend(options, r);
                    let response = op.responses[r];
                    checkResponse(response, contextServers, openapi, options);
                    options.context.pop();
                }
            }
            options.context.pop();
            let localPathParameters = clone(pathParameters);

            let opParameters = {};
            if (typeof op.parameters !== 'undefined') {
                should(op.parameters).be.an.Array();
                contextAppend(options, 'parameters');
                for (let p in op.parameters) {
                    let param = checkParam(op.parameters[p], p, path, contextServers, openapi, options);
                    if (opParameters[param.in+':'+param.name]) {
                        should.fail(false,true,'Duplicate operation-level parameter '+param.name);
                    }
                    else {
                        opParameters[param.in+':'+param.name] = param;
                        delete localPathParameters[param.in+':'+param.name];
                    }
                }
                options.context.pop();
            }

            let contextParameters = Object.assign({},localPathParameters,opParameters);
            path.replace(/\{(.+?)\}/g, function (match, group1) {
                if (!contextParameters['path:'+group1]) {
                    should.fail(false,true,'Templated parameter '+group1+' not found');
                }
            });

            if (typeof op.deprecated !== 'undefined') {
                should(op.deprecated).be.a.Boolean();
            }
            if (typeof op.externalDocs !== 'undefined') {
                contextAppend(options, 'externalDocs');
                should(op.externalDocs).be.an.Object();
                op.externalDocs.should.not.be.an.Array();
                op.externalDocs.should.have.key('url');
                if (typeof op.externalDocs.description !== 'undefined') {
                    should(op.externalDocs.description).be.a.String();
                }
                should.doesNotThrow(function () { validateUrl(op.externalDocs.url, contextServers, 'externalDocs', options) },'Invalid externalDocs.url');
                if (options.lint) options.linter('externalDocs',op.externalDocs,'externalDocs',options);
                options.context.pop();
            }
            if (op.callbacks) {
                contextAppend(options, 'callbacks');
                for (let c in op.callbacks) {
                    let callback = op.callbacks[c];
                    if (callback && typeof callback.$ref !== 'undefined') {
                        if (options.lint) options.linter('reference',callback,'$ref',options);
                    }
                    else {
                        contextAppend(options, c);
                        for (let p in callback) {
                            let cbPi = callback[p];
                            options.isCallback = true;
                            checkPathItem(cbPi, p, openapi, options);
                            options.isCallBack = false;
                        }
                        options.context.pop();
                    }
                }
                options.context.pop();
            }
            if (op.security) {
                checkSecurity(op.security,openapi,options);
            }
            if (options.lint) options.linter('operation',op,o,options);
        }
        else if (!o.startsWith('x-')) {
            should.fail(false,true,'PathItem should not have additional property '+o);
        }
        options.context.pop();
    }
    if (options.lint) options.linter('pathItem',pathItem,path,options);
    if (options.lint) options.linter('paths',openapi.paths,path,options);
    return true;
}

function checkSecurity(security,openapi,options) {
    contextAppend(options, 'security');
    should(security).be.an.Array();
    //common.distinctArray(security).should.be.exactly(true,'security array should be distinct'); // TODO move to linter
    for (let sr of security) {
        sr.should.be.an.Object();
        sr.should.not.be.an.Array();
        for (let i in sr) {
            should(sr[i]).be.an.Array();
            let sec = jptr.jptr(openapi,'#/components/securitySchemes/'+i);
            sec.should.not.be.exactly(false,'Could not dereference securityScheme '+i);
            if (sec.type !== 'oauth2') {
                sr[i].should.be.empty();
            }
            else if (sr[i].length) {
                if (!options.allScopes[i]) {
                    options.allScopes[i] = {};
                    if (sec.flows.password) Object.assign(options.allScopes[i],sec.flows.password.scopes);
                    if (sec.flows.implicit) Object.assign(options.allScopes[i],sec.flows.implicit.scopes);
                    if (sec.flows.authorizationCode) Object.assign(options.allScopes[i],sec.flows.authorizationCode.scopes);
                    if (sec.flows.clientCredentials) Object.assign(options.allScopes[i],sec.flows.clientCredentials.scopes);
                }
                for (let scope of sr[i]) {
                    options.allScopes[i].should.have.property(scope);
                }
            }
        }
    }
    if (options.lint) options.linter('security',security,'security',options);
    options.context.pop();
}

function validateSync(openapi, options, callback) {
    setupOptions(options,openapi);
    let contextServers = [];

    if (options.jsonschema) {
        let schemaStr = fs.readFileSync(options.jsonschema, 'utf8');
        openapi3Schema = yaml.safeLoad(schemaStr, { json: true });
        validateOpenAPI3 = ajv.compile(openapi3Schema);
    }

    if (options.validateSchema === 'first') {
        schemaValidate(openapi, options);
    }

    should(openapi).be.an.Object();
    openapi.should.not.have.key('swagger');
    openapi.should.have.key('openapi');
    openapi.openapi.should.have.type('string');
    should.ok(openapi.openapi.startsWith('3.0.'), 'Must be an OpenAPI 3.0.x document');
    openapi.should.not.have.key('host');
    openapi.should.not.have.key('basePath');
    openapi.should.not.have.key('schemes');
    openapi.should.have.key('paths');
    should(openapi.paths).be.an.Object();
    openapi.should.not.have.key('definitions');
    openapi.should.not.have.key('parameters');
    openapi.should.not.have.key('responses');
    openapi.should.not.have.key('securityDefinitions');
    openapi.should.not.have.key('produces');
    openapi.should.not.have.key('consumes');

    for (let k in openapi) {
        if (!k.startsWith('x-')) {
            should(['openapi','info','servers','security','externalDocs','tags','paths','components'].indexOf(k)).be.greaterThan(-1,'OpenAPI object cannot have additionalProperty: '+k);
        }
    }

    openapi.should.have.key('info');
    should(openapi.info).be.an.Object();
    openapi.info.should.not.be.an.Array();
    contextAppend(options, 'info');
    openapi.info.should.have.key('title');
    should(openapi.info.title).be.type('string', 'title should be of type string');
    openapi.info.should.have.key('version');
    should(openapi.info.version).be.type('string', 'version should be of type string');
    if (typeof openapi.servers !== 'undefined') {
        should(openapi.servers).be.an.Object();
        contextAppend(options, 'servers');
        checkServers(openapi.servers, options);
        options.context.pop();
        contextServers.push(openapi.servers);
    }
    if (typeof openapi.info.license !== 'undefined') {
        should(openapi.info.license).be.an.Object();
        openapi.info.license.should.not.be.an.Array();
        contextAppend(options, 'license');
        openapi.info.license.should.have.key('name');
        should(openapi.info.license.name).have.type('string');
        if (typeof openapi.info.license.url !== 'undefined') {
            should.doesNotThrow(function () { validateUrl(openapi.info.license.url, contextServers, 'license.url', options) },'Invalid license.url');
        }
        if (options.lint) options.linter('license',openapi.info.license,'license',options);
        options.context.pop();
    }
    if (typeof openapi.info.termsOfService !== 'undefined') {
        should.doesNotThrow(function () { validateUrl(openapi.info.termsOfService, contextServers, 'termsOfService', options) },'Invalid termsOfService.url');
    }
    if (typeof openapi.info.contact !== 'undefined') {
        contextAppend(options, 'contact');
        should(openapi.info.contact).be.type('object');
        should(openapi.info.contact).not.be.an.Array();
        should(openapi.info.contact).not.be.Null();
        if (typeof openapi.info.contact.name !== 'undefined') {
            should(openapi.info.contact.name).be.a.String();
        }
        if (typeof openapi.info.contact.url !== 'undefined') {
            should.doesNotThrow(function () { validateUrl(openapi.info.contact.url, contextServers, 'url', options) },'Invalid contact.url');
        }
        if (typeof openapi.info.contact.email !== 'undefined') {
            should(openapi.info.contact.email).be.a.String();
            should(openapi.info.contact.email.indexOf('@')).be.greaterThan(-1,'Contact email must be a valid email address');
            should(openapi.info.contact.email.indexOf('.')).be.greaterThan(-1,'Contact email must be a valid email address');
        }
        if (options.lint) options.linter('contact',openapi.info.contact,'contact',options);
        for (let k in openapi.info.contact) {
            if (!k.startsWith('x-')) {
                should(['name','url','email'].indexOf(k)).be.greaterThan(-1,'info object cannot have additionalProperty: '+k);
            }
        }
        options.context.pop();
    }
    if (typeof openapi.info.description !== 'undefined') {
        should(openapi.info.description).be.a.String();
    }
    if (options.lint) options.linter('info',openapi.info,'info',options);
    options.context.pop();

    if (typeof openapi.externalDocs !== 'undefined') {
        should(openapi.externalDocs).be.an.Object();
        contextAppend(options, 'externalDocs');
        openapi.externalDocs.should.have.key('url');
        if (typeof openapi.externalDocs.description !== 'undefined') {
            should(openapi.externalDocs.description).be.a.String();
        }
        should.doesNotThrow(function () { validateUrl(openapi.externalDocs.url, contextServers, 'externalDocs', options) },'Invalid externalDocs.url');
        if (options.lint) options.linter('externalDocs',openapi.externalDocs,'externalDocs',options);
        options.context.pop();
    }

    if (typeof openapi.tags !== 'undefined') {
        should(openapi.tags).be.an.Array();
        contextAppend(options, 'tags');
        let tagsSeen = new Map();
        for (let tag of openapi.tags) {
            tag.should.have.property('name');
            contextAppend(options, tag.name);
            should(tag.name).be.a.String();
            tagsSeen.has(tag.name).should.be.exactly(false,'Tag names must be unique');
            tagsSeen.set(tag.name,true);
            if (typeof tag.externalDocs !== 'undefined') {
                contextAppend(options, 'externalDocs');
                should(tag.externalDocs).be.an.Object();
                tag.externalDocs.should.not.be.an.Array();
                if (typeof tag.externalDocs.description !== 'undefined') {
                    should(tag.externalDocs.description).be.a.String();
                }
                tag.externalDocs.should.have.key('url');
                should.doesNotThrow(function () { validateUrl(tag.externalDocs.url, contextServers, 'tag.externalDocs', options) },'Invalid externalDocs.url');
                if (options.lint) options.linter('externalDocs',tag.externalDocs,'externalDocs',options);
                options.context.pop();
            }
            if (typeof tag.description !== 'undefined') {
                should(tag.description).be.a.String();
            }
            if (options.lint) options.linter('tag',tag,tag.name,options); // should be index
            options.context.pop();
        }
        options.context.pop();
    }

    if (typeof openapi.security !== 'undefined') {
        checkSecurity(openapi.security,openapi,options);
    }

    if (typeof openapi.components !== 'undefined') {
        options.context.push('#/components');
        should(openapi.components).be.an.Object();
        openapi.components.should.not.be.an.Array();
        if (options.lint) options.linter('components',openapi.components,'components',options);
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.securitySchemes !== 'undefined')) {
        options.context.push('#/components/securitySchemes');
        should(openapi.components.securitySchemes).be.an.Object();
        openapi.components.securitySchemes.should.not.be.an.Array();
        for (let s in openapi.components.securitySchemes) {
            options.context.push('#/components/securitySchemes/' + s);
            validateComponentName(s).should.be.equal(true, 'component name invalid');
            let scheme = openapi.components.securitySchemes[s];
            scheme.should.have.property('type');
            scheme.type.should.have.type('string');
            scheme.type.should.not.be.exactly('basic', 'Security scheme basic should be http with scheme basic');
            scheme.type.should.equalOneOf('apiKey', 'http', 'oauth2', 'openIdConnect');
            if (scheme.type === 'http') {
                scheme.should.have.property('scheme');
                scheme.scheme.should.have.type('string');
                if (scheme.scheme != 'bearer') {
                    scheme.should.not.have.property('bearerFormat');
                }
            }
            else {
                scheme.should.not.have.property('scheme');
                scheme.should.not.have.property('bearerFormat');
            }
            if (scheme.type === 'apiKey') {
                scheme.should.have.property('name');
                scheme.name.should.have.type('string');
                scheme.should.have.property('in');
                scheme.in.should.have.type('string');
                scheme.in.should.equalOneOf('query', 'header', 'cookie');
            }
            else {
                scheme.should.not.have.property('name');
                scheme.should.not.have.property('in');
            }
            if (scheme.type === 'oauth2') {
                scheme.should.not.have.property('flow');
                scheme.should.have.property('flows');
                for (let f in scheme.flows) {
                    let flow = scheme.flows[f];
                    should(['implicit','password','authorizationCode','clientCredentials'].indexOf(f)).be.greaterThan(-1,'Unknown flow type: '+f);

                    if ((f === 'implicit') || (f === 'authorizationCode')) {
                        flow.should.have.property('authorizationUrl');
                        should.doesNotThrow(function () { validateUrl(flow.authorizationUrl, contextServers, 'authorizationUrl', options) },'Invalid authorizationUrl');
                    }
                    else {
                        flow.should.not.have.property('authorizationUrl');
                    }
                    if ((f === 'password') || (f === 'clientCredentials') ||
                        (f === 'authorizationCode')) {
                        flow.should.have.property('tokenUrl');
                        should.doesNotThrow(function () { validateUrl(flow.tokenUrl, contextServers, 'tokenUrl', options) },'Invalid tokenUrl');
                    }
                    else {
                        flow.should.not.have.property('tokenUrl');
                    }
                    if (typeof flow.refreshUrl !== 'undefined') {
                        should.doesNotThrow(function () { validateUrl(flow.refreshUrl, contextServers, 'refreshUrl', options) },'Invalid refreshUrl');
                    }
                    flow.should.have.property('scopes');
                    flow.scopes.should.be.an.Object();
                    flow.scopes.should.not.be.an.Array();
                }
            }
            else {
                scheme.should.not.have.property('flows');
            }
            if (scheme.type === 'openIdConnect') {
                scheme.should.have.property('openIdConnectUrl');
                should.doesNotThrow(function () { validateUrl(scheme.openIdConnectUrl, contextServers, 'openIdConnectUrl', options) },'Invalid openIdConnectUrl');
            }
            else {
                scheme.should.not.have.property('openIdConnectUrl');
            }
            options.context.pop();
        }
        options.context.pop();
    }

    recurse(openapi, null, function (obj, key, state) {
        if (isRef(obj,key)) {
            options.context.push(state.path);
            obj[key].should.not.startWith('#/definitions/');
            let refUrl = url.parse(obj[key]);
            if (!refUrl.protocol && !refUrl.path) {
                should(obj[key]+'/%24ref').not.be.equal(state.path,'Circular reference');
                should(jptr.jptr(openapi,obj[key])).not.be.exactly(false, 'Cannot resolve reference: ' + obj[key]);
            }
            options.context.pop();
        }
    });

    let paths = {};

    for (let p in openapi.paths) {
        options.context.push('#/paths/' + jptr.jpescape(p));
        if (!p.startsWith('x-')) {
            p.should.startWith('/');
            let pCount = 0;
            let template = p.replace(/\{(.+?)\}/g, function (match, group1) {
                return '{'+(pCount++)+'}';
            });
            if (paths[template] && !openapi["x-hasEquivalentPaths"]) {
                should.fail(false,true,'Identical path templates detected');
            }
            paths[template] = {};
            let templateCheck = p.replace(/\{(.+?)\}/g, function (match, group1) {
                return '';
            });
            if ((templateCheck.indexOf('{')>=0) || (templateCheck.indexOf('}')>=0)) {
                should.fail(false,true,'Mismatched {} in path template');
            }

            checkPathItem(openapi.paths[p], p, openapi, options);
        }
        options.context.pop();
    }
    if (openapi["x-ms-paths"]) {
        for (let p in openapi["x-ms-paths"]) {
            options.context.push('#/x-ms-paths/' + jptr.jpescape(p));
            p.should.startWith('/');
            checkPathItem(openapi["x-ms-paths"][p], p, openapi, options);
            options.context.pop();
        }
    }

    if (openapi.components && (typeof openapi.components.parameters !== 'undefined')) {
        options.context.push('#/components/parameters/');
        should(openapi.components.parameters).be.an.Object();
        openapi.components.parameters.should.not.be.an.Array();
        for (let p in openapi.components.parameters) {
            checkParam(openapi.components.parameters[p], p, '', contextServers, openapi, options);
            contextAppend(options, p);
            validateComponentName(p).should.be.equal(true, 'component name invalid');
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.schemas !== 'undefined')) {
        options.context.push('#/components/schemas');
        should(openapi.components.schemas).be.an.Object();
        openapi.components.schemas.should.not.be.an.Array();
        for (let s in openapi.components.schemas) {
            options.context.push('#/components/schemas/' + s);
            validateComponentName(s).should.be.equal(true, 'component name invalid');
            checkSchema(openapi.components.schemas[s], dummySchema, '', openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.responses !== 'undefined')) {
        options.context.push('#/components/responses');
        should(openapi.components.responses).be.an.Object();
        openapi.components.responses.should.not.be.an.Array();
        for (let r in openapi.components.responses) {
            options.context.push('#/components/responses/' + r);
            validateComponentName(r).should.be.equal(true, 'component name invalid');
            checkResponse(openapi.components.responses[r], contextServers, openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.headers !== 'undefined')) {
        options.context.push('#/components/headers');
        should(openapi.components.headers).be.an.Object();
        openapi.components.headers.should.not.be.an.Array();
        for (let h in openapi.components.headers) {
            options.context.push('#/components/headers/' + h);
            validateComponentName(h).should.be.equal(true, 'component name invalid');
            checkHeader(openapi.components.headers[h], contextServers, openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.requestBodies !== 'undefined')) {
        options.context.push('#/components/requestBodies');
        should(openapi.components.requestBodies).be.an.Object();
        openapi.components.requestBodies.should.not.be.an.Array();
        for (let r in openapi.components.requestBodies) {
            options.context.push('#/components/requestBodies/' + r);
            validateComponentName(r).should.be.equal(true, 'component name invalid');
            if (r.startsWith('requestBody')) {
                options.warnings.push('Anonymous requestBody: ' + r);
            }
            let rb = openapi.components.requestBodies[r];
            rb.should.have.property('content');
            if (typeof rb.description !== 'undefined') should(rb.description).have.type('string');
            if (typeof rb.required !== 'undefined') should(rb.required).have.type('boolean');
            checkContent(rb.content, openapi.servers, openapi, options);
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.examples !== 'undefined')) {
        options.context.push('#/components/examples');
        should(openapi.components.examples).be.an.Object();
        openapi.components.examples.should.not.be.an.Array();
        for (let e in openapi.components.examples) {
            options.context.push('#/components/examples/' + e);
            validateComponentName(e).should.be.equal(true, 'component name invalid');
            let ex = openapi.components.examples[e];
            if (typeof ex.$ref !== 'undefined') {
                if (options.lint) options.linter('reference',ex,'$ref',options);
            }
            else {
                checkExample(ex, openapi.servers, openapi, options);
            }
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.callbacks !== 'undefined')) {
        options.context.push('#/components/callbacks');
        should(openapi.components.callbacks).be.an.Object();
        openapi.components.callbacks.should.not.be.an.Array();
        for (let c in openapi.components.callbacks) {
            options.context.push('#/components/callbacks/' + c);
            validateComponentName(c).should.be.equal(true, 'component name invalid');
            let cb = openapi.components.callbacks[c];
            if (typeof cb.$ref !== 'undefined') {
                if (options.lint) options.linter('reference',cb,'$ref',options);
            }
            else {
                for (let exp in cb) {
                    let cbPi = cb[exp];
                    options.isCallback = true;
                    checkPathItem(cbPi, exp, openapi, options);
                    options.isCallback = false;
                }
            }
            options.context.pop();
        }
        options.context.pop();
    }

    if (openapi.components && (typeof openapi.components.links !== 'undefined')) {
        options.context.push('#/components/links');
        should(openapi.components.links).be.type('object');
        openapi.components.links.should.not.be.an.Array();
        for (let l in openapi.components.links) {
            options.context.push('#/components/links/' + l);
            validateComponentName(l).should.be.equal(true, 'component name invalid');
            let link = openapi.components.links[l];
            if (typeof link.$ref !== 'undefined') {
                if (options.lint) options.linter('reference',link,'$ref',options);
            }
            else {
                checkLink(link, openapi, options);
            }
            options.context.pop();
        }
        options.context.pop();
    }

    if (!options.validateSchema || (options.validateSchema === 'last')) {
        schemaValidate(openapi, options);
    }

    options.valid = !options.expectFailure;
    if (options.lint) options.linter('openapi',openapi,'',options);
    if (callback) callback(null, options);
    return options.valid;
}

function schemaValidate(openapi, options) {
    validateOpenAPI3(openapi);
    let errors = validateOpenAPI3.errors;
    if (errors && errors.length) {
        if (options.prettify) {
            const errorStr = bae(options.schema, openapi, errors, { indent: 2 });
            throw (new CLIError(errorStr));
        }
        throw (new JSONSchemaError('Failed OpenAPI3 schema validation: ' + JSON.stringify(errors, null, 2)));
    }
}

function setupOptions(options,openapi) {
    options.valid = false;
    options.context = [ '#/' ];
    options.warnings = [];
    options.operationIds = [];
    options.allScopes = {};
    options.openapi = openapi;
    if (options.lint && !options.linter) options.linter = linter.lint;
    if (!options.cache) options.cache = {};
}

function validate(openapi, options, callback) {
    setupOptions(options,openapi);

    let actions = [];

    resolver.optionalResolve(options)
    .then(function(){
        options.context = [];
        validateSync(openapi, options, callback);
    })
    .catch(function (err) {
        callback(err,options);
        return false;
    });
}

module.exports = {
    validateSync: validateSync,
    validate: validate,
    JSONSchemaError: JSONSchemaError,
    CLIError: CLIError
}
