/**
 * Created by suman on 10/05/16.
 */

(function () {

  var clc = require("cli-color"),
    request = require('request'),
    _ = require('lodash'),
    express = require('express'),
    server = express(),
    bodyParser = require('body-parser'),
    https = require('https'),
    Q = require('q'),
    path = require('path'),
    JSONbig = require('json-bigint');

  var core = {}, app = {}, chatSession = {};

  var artifacts = {
    validators: {},
    responses: {},
    expectations: {},
    responseExpectation: {}
  };

  function register(type) {
    return function (name, body, next) {
      if (_.isUndefined(artifacts[type][name])) {
        artifacts[type][name] = body;
        if (!_.isUndefined(next) && type === 'responses') {
          artifacts.responseExpectation[name] = next;
        }
      } else {
        console.error(clc.red(type + ' : ' + name + ' already registered'));
      }
    };
  }

  function listArtifacts(type) {
    return function () {
      return _.keys(artifacts[type])
    };
  }

  function invoke(type) {
    return function (name, params) {
      if (_.isUndefined(artifacts[type][name])) {
        console.error(clc.red(name + ' is not a registered ' + type + '!!! You may want to check for typo as well.'));
      } else {
        if (type === 'responses') {
          if (_.isUndefined(artifacts.responseExpectation[name])) {
            chatSession[params.id].expectation = 'postback';
          } else {
            chatSession[params.id].expectation = artifacts.responseExpectation[name];
          }
        }

        return artifacts[type][name].call(this, params)
      }
    };
  }

  /**
   * Validators
   */

  core.validator = register('validators');

  core.getAllValidators = listArtifacts('validators');

  core.validate = invoke('validators');

  /**
   * Responses
   */

  core.response = register('responses');

  core.getAllResponses = listArtifacts('responses');

  core.respond = invoke('responses');

  /**
   * Expectations
   */

  core.expectation = register('expectations');

  core.getAllExpectations = listArtifacts('expectations');

  core.expect = function (expectation, payload, sender) {
    var foo = artifacts.expectations[expectation].call(this, payload);
    var validationResult = core.validate(foo.validators[0], payload);
    return validationResult.then(function (res) {
      if (res) {
        return Q.fcall(function () {
          if (_.isString(res)) {
            foo.success.push(res);
          }
          return core.respond(foo.success[0], sender, payload);
        });
      } else {
        return Q.fcall(function () {
          return core.respond(foo.fail[0], sender);
        });
      }
    }, function (err) {
      console.log(err);
    });
  };

  /**
   * Process Expectation
   * @param payload
   */
  core.processExpectation = function (payload, sender) {
    if (chatSession[sender.id].expectation !== 'postback') {
      return core.expect(chatSession[sender.id].expectation, payload, sender).then(
        function (res) {
          return res;
        }, function (err) {
          return err;
        }
      );
    } else {
      return Q.fcall(function () {
        return core.respond('fail', sender);
      });
    }
  };

  /**
   * Process Postback
   * @param payload
   * @param sender
   * @returns {*}
   */
  core.processPostback = function (payload, sender) {
    // return chatSession[sender.id].expectation === 'postback' ? core.respond(payload, sender) : core.respond('fail', sender);
    return core.respond(payload, sender);
  };

  core.dispatch = function (message, sender) {
    request({
      url: 'https://graph.facebook.com/v2.6/me/messages',
      qs: {access_token: app.token},
      method: 'POST',
      json: {
        recipient: {id: sender.id},
        message: message,
      }
    }, function (error, response) {
      if (error) {
        console.log('Error sending message: ', error);
      } else if (response.body.error) {
        console.log('Error: ', response.body.error);
      }
    });
  };

  core.bootstrap = function (config) {
    app.expectation = config.expectation;
    app.token = config.token;
    app.mount = config.mount;
    mount(app.mount);
  };

  core.getExpectation = function () {
    return app.expectation;
  };

  var mount = function (mountPoint) {
    var libs = require('require-all')(__dirname + '/../../' + mountPoint);
  }

  server.set('port', (process.env.PORT || 3000));

  server.use(bodyParser.urlencoded({extended: false}));
  server.use(bodyParser.text({type: 'application/json'}))

  server.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, '../../public', 'index.html'));
  });

  server.get('/mi.png', function (req, res) {
    res.sendFile(path.join(__dirname, '../../public', 'mi.png'));
  });

  server.get('/webhook', function (req, res) {
    console.log('get webhook' + req.query['hub.verify_token']);
    if (req.query['hub.verify_token'] === app.token) {
      res.send(req.query['hub.challenge']);
    } else {
      res.send('Error, wrong validation token');
    }
  });

  server.post('/webhook/', function (req, res) {

    var body = JSONbig.parse(req.body);

    _.each(body.entry[0].messaging, function (event) {
      var sender = event.sender.id.toString();
      if (_.isUndefined(chatSession[sender])) {
        https.get('https://graph.facebook.com/v2.6/' + sender + '?access_token=' + app.token, function (res) {
          res.setEncoding('utf8');
          res.on('data', function (d) {
            d = JSON.parse(d);
            d.id = sender;
            d.expectation = app.expectation;
            chatSession[sender] = _.clone(d);
            handleMessage(event, chatSession[sender]);
          });
        }).on('error', function (e) {
          console.error(e);
        });
      } else {
        handleMessage(event, chatSession[sender]);
      }
    })

    res.sendStatus(200);
  });

  server.listen(server.get('port'), function () {
    console.log('Node server is running on port', server.get('port'));
  });

  function handleMessage(event, sender) {
    if (event.message && event.message.text) {
      core.processExpectation(event.message.text, sender).then(function (res) {
        core.dispatch(res, sender);
      }, function (err) {
        console.log(err);
      })
    } else if (event.postback) {
      core.dispatch(core.processPostback(event.postback.payload, sender), sender);
    } else if (event.message && event.message.attachments) {
      core.dispatch(event.message.attachments[0].payload.url, sender);
    }
  }

  module.exports = core;

}());
