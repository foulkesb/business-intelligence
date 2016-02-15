// Copyright (c) 2016 IBM Corp. All rights reserved.
// Use of this source code is governed by the Apache License,
// Version 2.0, a copy of which can be found in the LICENSE file.

/* callERS.js
 * The following file represents an instance of a call to the Embeddable Reporting Service (ERS)
 * Parses JSESSIONID cookies where necessary and routes requests to and from ERS
 */

// ERS connection constructor
function callERS(ersUri, username, password, bundleUri) {
	var url = require('url');
	var ersContextRoot = null;
	var cookieJar = "";

	// return appropriate connection depending on whether reporting
	// service is listening on http or https
	var getConnection = function(uri) {
		if (url.parse(uri).protocol === 'https:') {
			return require('https');
		} else {
			return require('http');
		}
	};

	// returns the host name of the reporting service
	var getHost = function(uri) {
		return url.parse(uri).hostname;
	};

	// returns the port of the reporting service
	var getPort = function(uri) {
		if (url.parse(uri).protocol === 'https:') {
			return (url.parse(uri).port || 443);
		} else {
			return (url.parse(uri).port || 80);
		}
	};
	
	// set the context root that will be used as a prefix on URLs generated by ERS.
	this.setContextRoot = function(contextRoot) {
		ersContextRoot = contextRoot;
	};
		
	// setup connection information for reporting service
	var ersHost = getHost(ersUri);
	var ersPort = getPort(ersUri);
	var ersConnection = getConnection(ersUri);

	var ersAuth = username + ':' + password;
	var ersBundleUri = bundleUri;

	// connects to the reporting service and retrieves a connection id
	// for the specified bundle uri. If a callback has been specified,
	// the original request and response are provided so that a retry
	// of the original request can be attempted.
	this.doConnect = function(clientRequest, clientResponse, callback, ers) {

		if(cookieJar != ""){
			cookieJar = "";
		}
				
		var responseCallback = function(ersResponse) {
			var str = '';

			ersResponse.on('data', function(chunk) {
				str += chunk;
			});

			ersResponse.on('end', function() {
				var ersHeaders = ersResponse.headers;
				for ( var headerName in ersHeaders) {
					var headerValue = ersHeaders[headerName];
					if (headerName === 'set-cookie') {
						
						for (idx = 0; idx < headerValue.length; idx++) {							
							var cookie = headerValue[idx].substring(0, headerValue[idx].indexOf(';') + 1);
							cookieJar += cookie;
						}
					} 
				}
				
				if (callback) {
					return callback(ersResponse.statusCode, clientRequest, clientResponse, ers);
				}
			});
		};

		var options = {
			host : ersHost,
			port : ersPort,
			path : '/ers/v1/connection',
			method : 'POST',
			auth : ersAuth
		};

		var ersRequest = ersConnection.request(options, responseCallback);

		ersRequest.setHeader('Content-Type', 'application/json');
		
		ersRequest.on('error', function(e) {
			if (callback) {
				return callback(503, clientRequest, clientResponse, ers);
			}
		});

		ersRequest.write("{}");
		ersRequest.end();
	};

	// disconnects from the reporting service
	this.doDisconnect = function() {
		var responseCallback = function(ersResponse) {

			ersResponse.on('data', function(chunk) {
			});

			ersResponse.on('end', function() {
			});
		};

		var options = {
				host : ersHost,
				port : ersPort,
				path : '/ers/v1/connection',
				method : 'DELETE',
				auth : ersAuth
			};

		var ersRequest = ersConnection.request(options, responseCallback);

		cookieJar = "";
		ersRequest.end();
	};
	
	//For Testing
	this.getCookieJar = function(){
		return cookieJar;
	};

	// Issues a request to the reporting service. If a callback has been
	// specified, the original request and response are returned so that
	// a retry can be attempted if desired.
	this.doVerb = function(clientRequest, clientResponse, callback, ers) {
		var queryString = url.parse(clientRequest.url).search;
		
		var copyRequestHeaders = function(clientRequest, ersRequest) {
			var clientHeaders = clientRequest.headers;
			
			for ( var headerName in clientHeaders) {
				headerValue = clientHeaders[headerName];
				
				if (headerName === 'host') {
					continue;
				}
				else{
					ersRequest.setHeader(headerName, headerValue);
				}				
			}

			ersRequest.setHeader('cookie', cookieJar);
		};

		var copyRequestBody = function (clientRequest, ersRequest) {
			clientRequest.on('data', function (chunk) {
				ersRequest.write(chunk, 'binary');
			});
		};
		
		var copyResponseHeaders = function(ersResponse, clientResponse) {
			
			var ersHeaders = ersResponse.headers;
			for ( var headerName in ersHeaders) {
				var headerValue = ersHeaders[headerName];
				
				if (headerName === 'set-cookie') {
					continue;
				} else {
					clientResponse.setHeader(headerName, headerValue);
				}
			}
		};

		var responseCallback = function(ersResponse) {
			
			if (!callback || ersResponse.statusCode !== 404) {
				clientResponse.statusCode = ersResponse.statusCode;
				copyResponseHeaders(ersResponse, clientResponse);
			}

			ersResponse.on('data', function(chunk) {	
				if (!callback || ersResponse.statusCode !== 404) {
					clientResponse.write(chunk, 'binary');
				}
			});

			ersResponse.on('end', function() {
				if (ersResponse.statusCode !== 404) {
					clientResponse.end();
				}

				if (callback && ersResponse.statusCode === 404) {
					return callback(ersResponse.statusCode, clientRequest, clientResponse, ers);
				}
			});
		};

		var path = url.parse(clientRequest.url).pathname;
		
		if (queryString != null) {
			path = path + queryString;
		}
		
		var options = {
			host : ersHost,
			port : ersPort,
			path : path,
			method : clientRequest.method,
			auth : ersAuth
		};
		
		var ersRequest = ersConnection.request(options, responseCallback);

		copyRequestHeaders(clientRequest, ersRequest);		
		copyRequestBody(clientRequest, ersRequest);

		if (ersContextRoot != null) {
			ersRequest.setHeader('ERS-ContextRoot', ersContextRoot);
		}
		
		ersRequest.on('error', function(e) {
			clientResponse.statusCode = 503;
			if (callback) {
				return callback(clientResponse.statusCode, clientRequest, clientResponse, ers);
			} else {
				clientResponse.end();
			}
		});

		ersRequest.end();
	};
}

//ers reconnect handler
//
// If a 404 is returned for the reconnect attempt, do not retry the request.
var ersReconnectHandler = function (statusCode, originalRequest, originalResponse, ers) {
	if (statusCode === 404) {
		originalResponse.statusCode = statusCode;
		originalResponse.end();
		return;
	}

	// try the request again, except this time do not specify
	// a retry handler (otherwise an infinite loop could occur)
	ers.doVerb(originalRequest, originalResponse, null, null);
};

// ers retry handler
//
// If a 404 is returned on the first attempt
var ersRetryHandler = function (statusCode, originalRequest, originalResponse, ers) {
	if (statusCode === 404) {
		ers.doConnect(originalRequest, originalResponse, ersReconnectHandler, ers);
		return;
	}
};

// public methods

// Connects to the reporting service and retrieves a JSESSIONID cookie
// for the specified bundle uri. 
callERS.prototype.connect = function() {
	this.doConnect(null, null, null, null);
};

// Disconnects from the reporting service and invalidates the
// session cookie
callERS.prototype.disconnect = function() {
	this.doDisconnect();
};

// Issues a request to the reporting service.
callERS.prototype.execute = function(clientRequest, clientResponse) {
	this.doVerb(clientRequest, clientResponse, ersRetryHandler, this);
};

// Set the context root.
callERS.prototype.setContextRoot = function(contextRoot) {
	this.setContextRoot(contextRoot);
};

//for testing
callERS.prototype.getCookieJar = function() {
	this.getCookieJar();
};

// export the class
module.exports = callERS;