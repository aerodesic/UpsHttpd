// upshttps.js
//
//
// functions that begin with 'ev_' are 'event-like' functions called
// from onchange or other callback generators.
//
var LONG_POLL_INTERVAL  = 20000;
var SHORT_POLL_INTERVAL = 4000;
//var LONG_POLL_INTERVAL = 2000;
//var SHORT_POLL_INTERVAL = 1000;
var HTTP_RECV_TIMEOUT   = 10000;
var MAX_HTTP_RETRIES = 10;

var comm_stalled = false;
var msg_queue = [];
var host_url = document.location.origin;

// Transmit an event to event handler(s)
function send_special_event(name, value) {
  var event = document.createEvent('CustomEvent');
  event.initCustomEvent(name, true, true, value);
  document.documentElement.dispatchEvent(event);
}

// Set the value of an item
function set_value(name, value) {
  var obj = document.getElementById(name);
  if (obj) {
    if (obj.type === 'checkbox') {
      obj.checked = value;
    } else {
      obj.value = value;
    }
  }
}

// Returns the raw value of an item
function get_value(name) {
  var value;
  var obj = document.getElementById(name);
  if (obj) {
    if (obj.type === 'checkbox') {
      value = obj.checked;
    } else if (obj.type === 'select-one') {
      var selected = obj.options[obj.selectedIndex];
      value = selected.innerText;
      var extra_value = selected.getAttribute('extra-value')
      if (extra_value !== null) {
        // Return extra value placed in value cell
        value = [ value, extra_value ];
      }
    } else {
      value = obj.value;
    }
  }
  return value;
}

function set_attribute(name, attribute, value) {
  var obj = document.getElementById(name);
  if (obj) {
    obj.setAttribute(attribute, value);
  }
}

function remove_attribute(name, attribute) {
  var obj = document.getElementById(name);
  if (obj) {
    obj.removeAttribute(attribute);
  }
}

function get_enabled(name) {
  var value;
  var obj = document.getElementById(name);
  if (obj) {
    value = obj.disabled;
  }
  return value;
}

function set_enabled(name, value) {
  var obj = document.getElementById(name);
  if (obj) {
    if (value) {
      obj.removeAttribute('disabled');
      remove_class(name, 'dim');
    } else {
      obj.setAttribute('disabled', 'disabled');
      add_class(name, 'dim');
    }
  }
}

function has_class(obj, class_name) {
  var has = false;

  // If a string, look it up
  if (typeof(obj) === 'string') {
    obj = document.getElementById(obj);
  }

  if (obj) {
    if (obj.classList) {
      has = obj.classList.contains(class_name);
    } else {
      has = !!obj.className.matches(new RegExp('(\\s|^)' + class_name + '(\\s|$)'));
    }
  }
  return has;
}

function add_class(obj, class_name) {
  if (typeof(obj) === 'string') {
    obj = document.getElementById(obj);
  }

  if (obj) { 
    if (obj.classList) {
        obj.classList.add(class_name);
    } else if (!has_class(obj, class_name)) {
      obj.className += " " + class_name;
    }
  }
}

function remove_class(obj, class_name) {
  // If a string, look it up
  if (typeof(obj) === 'string') {
    obj = document.getElementById(obj);
  }

  if (obj) {
    if (obj.classList) {
      obj.classList.remove(class_name);
    } else if (has_class(obj, class_name)) {
      var reg = new RegExp('(\\s|^)' + class_name + '(\\s|$)');
      obj.className = obj.className.replace(reg, ' ');
    }
  }
}

function format_date(dt) {
  var datetime = new Date(dt);
  var da = ('0' + datetime.getDate()).slice(-2);
  var mo = ('0' + (datetime.getMonth() + 1)).slice(-2);
  var yr = datetime.getFullYear();
  var hh = ('0' + datetime.getHours()).slice(-2);
  var mm = ('0' + datetime.getMinutes()).slice(-2);
  var ss = ('0' + datetime.getSeconds()).slice(-2);

  return mo + '/' + da + '/' + yr + ' ' + hh + ':' + mm + ':' + ss;
}

// ctx - canvas surface
// x,y center of LED area
// r   - radius of LED
// pos 'upper' or 'lower'
function draw_text(ctx, size, font, label, x, y, r, pos) {
  ctx.font = 'bold ' + size.toString() + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'black';

  if (pos === 'upper') {
    y = y - r - 1;
    //y = y - r;
  } else {
    y = y + r + size;
    //y = y + r + size - 1;
  }

  ctx.fillText(label, x, y);
}

//
// Recalculate the size of the canvas based upon current screen size.
//
function recalc_size() {
  var top = document.getElementById('top');
  var bottom = document.getElementById('bottom');
  var canvas = document.getElementById('lights');

  canvas.width = top.offsetWidth;
  canvas.height = window.innerHeight - top.offsetHeight - bottom.offsetHeight;
}

// req is gentest command RESTful command.
function ups_request(req) {
  if (typeof(req) !== 'undefined') {
    var command = '/rest/' + req.cmd;
    var callback = req.callback;
    var data = req.data;
    var request = req.request;
    var payload = req.payload;

    // Add escapes around the \ and : because they have special meaning inthe command process
    // command = encode_backslashes(command);

    // Encode it for transport over html
    // command = encodeURIComponent(command);

    // Encode as URL and send it
    var url = host_url + command + '?' + new Date().getTime().toString();

    xml_http = new XMLHttpRequest();

    xml_http.ontimeout = function() {
      if (++http_retry > MAX_HTTP_RETRIES) {
        clearInterval(poll_timer);
        poll_timer = null;
        if (!comm_stalled) {
          comm_stalled = true;
          alert("Communication failed - reload page to restart.");
          // Empty the queue
          msg_queue = [];
        }
      } else {
        // Send it again in a few milliseconds
        setTimeout(function() { send_next_command() }, 500);
      }
    }

    xml_http.onreadystatechange = function() {
      if (xml_http.readyState === 4) {

        if (xml_http.status >= 200 && xml_http.status <= 299) {
          // If a callback is present, dispatch as event or function call
          if (callback !== null) {
            results = JSON.parse(xml_http.responseText);

            // If a callback is a string, send as an event
            if (typeof(callback) === 'function') {
              callback(results, payload);
            }
          }
          // Remove from queue
          msg_queue.splice(0, 1);
          http_retry = 0;
        } else {
          // an error occurred
          var text = xml_http.responseText;
        }

        // Clear queue and send next command in a few milliseconds
        setTimeout(function() {
          xml_http = null;
          send_next_command();
        }, 50);
      }
    };

    xml_http.open(request, url, true);

    if (data !== null && typeof(data) !== 'string') {
      // If data is not a 'string' then assume JSON attachment rather than just string
      xml_http.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
      data = JSON.stringify(data);
    }

    xml_http.timeout = HTTP_RECV_TIMEOUT;
    xml_http.send(data);
  }
}


function send_next_command() {
  if (!comm_stalled && !xml_http && msg_queue.length !== 0) {
    ups_request(msg_queue[0]);
  }
}

function in_string(item, strarray) {
  for (var i = 0; i < strarray.length; ++i) {
    if (strarray[i] === item) {
      return true;
    }
  }
  return false;
}

//
// Send a command.
//     cmd is the url portion.
//     callback is to trigger a callback when reply is received. 
//     data is the json to be sent with the request.
//
// If 'data' is null, request sent as GET, otherwise sent as a POST.
//
function send_gt(cmd, callback, data, request, payload) {
  callback = typeof(callback) !== 'undefined' ? callback : null;
  data = typeof(data) !== 'undefined' ? data : null;
  request = typeof(request) !== 'undefined' ? request : 'get';

  if (!comm_stalled) {
    if (queue_gt({ cmd: cmd, callback: callback, data:data, request:request, payload:payload })) {
      if (msg_queue.length === 1) {
        send_next_command();
      }
    }
  }
}

function queue_gt(request) {

  // Look for duplicate and return false if found
  for (var index in msg_queue) {
    var elem = msg_queue[index] ;
    if (elem.cmd === request.cmd) {
      return false;
    }
  }

  // Not found - insert new one into queue
  msg_queue.push(request);

  return true;
}

// Called when page is loaded
function ups_initialize() {
  // Make a request for a few variables
  send_gt('config/get/firmware_version', function(results) {
    set_value('firmware', results);
  });

  poll_timer = setInterval(function() { send_gt('status', process_status); }, SHORT_POLL_INTERVAL);
  android_device = navigator.userAgent.indexOf('Android') !== -1;
}

// Called when size changes
function ups_resize() {
}

function hide_element(name, classname) {
  if (typeof classname === 'undefined') {
    classname = 'hidden';
  }
  add_class(name, classname);
}

function show_element(name, classname) {
  if (typeof classname === 'undefined') {
    classname = 'hidden';
  }
  remove_class(name, classname);
}

// Create a table row with text only
function create_dialog_table_static(text1, text2) {
  if (typeof(text2) === 'undefined') {
    // Only do first element
    var tr = document.createElement('TR');
    var td = document.createElement('TD');
    td.innerHTML = text1;
    td.setAttribute('class', 'dialog_info centered bold')
    td.setAttribute('colspan', 2);
    tr.appendChild(td);
  } else {
    var tr = document.createElement('TR');
    var td = document.createElement('TD');
    td.setAttribute('class', 'dialog_info inline');
    if (typeof(text1) !== 'undefined') {
      td.innerHTML = text1;
    }
    tr.appendChild(td);

    if (typeof(text2) !== 'undefined') {
      td = document.createElement('TD');
      td.setAttribute('class', 'dialog_info')
      td.innerHTML = text2;
      tr.appendChild(td);
    }
  }

  return tr;
}

// Create a name: value table entry
function create_dialog_table_entry(name, id, type) {
  if (typeof(type) === 'undefined') {
    type = 'text';
  }
  var tr = document.createElement('TR');
  var td = document.createElement('TD');
  td.setAttribute('class', 'dialog_info');
  td.innerHTML = name + ':';
  tr.appendChild(td);
  td = document.createElement('TD');
  tr.appendChild(td);
  var input = document.createElement('INPUT');
  td.appendChild(input);
  input.setAttribute('type', type);
  input.setAttribute('id', id);
  input.setAttribute('class', 'dialog_info');
  if (type === 'text') {
    input.value = 'Undefined';
  }

  return tr;
}

function create_dialog_table_combo(name, id, items, onchange, selected, size) {
  var tr = document.createElement('TR');
  var td = document.createElement('TD');
  td.setAttribute('class', 'dialog_info');
  td.innerHTML = name + ':';
  tr.appendChild(td);
  td = document.createElement('TD');
  tr.appendChild(td);
  var select = document.createElement('SELECT');
  if (onchange != null && typeof(onchange) !== 'undefined') {
    select.setAttribute('onchange', onchange);
  }
  if (size != null && typeof(size) !== 'undefined') {
    select.setAttribute('size', size);
  }
  select.setAttribute('name', id);
  select.setAttribute('id', id);
  select.setAttribute('class', 'dialog_info');
  td.appendChild(select);

  for (var item = 0; item < items.length; ++item) {
    var option = document.createElement('OPTION');
    var item_name;
    var item_value;

    if (typeof(items[item]) === typeof([])) {
        // Item is a list of two things: [ '<name>', '<value>' ].  Set display as <name> and add 'value' attribute.
        item_name = items[item][0];
        option.setAttribute('extra-value', items[item][1]);
    } else {
        // Item is a singleton - just inner value
        item_name = items[item];
    }

    option.innerText = item_name;

    if (selected === item_name) {
       option.setAttribute('selected', 'yes')
    }

    select.appendChild(option);
  }

  return tr;
}

function create_dialog_table_checkbox(name, id, onchange, checked) {

  var tr = document.createElement('TR');
  var td = document.createElement('TD');
  td.setAttribute('class', 'use-font')
  td.innerHTML = name;
  tr.appendChild(td);
  td = document.createElement('TD');
  tr.appendChild(td);
  var checkbox = document.createElement('INPUT');
  td.appendChild(checkbox);
  td.setAttribute('class', 'lj');
  checkbox.setAttribute('type', 'checkbox');
  checkbox.setAttribute('id', id);
  checkbox.setAttribute('class', 'dialog_info');
  if (typeof(onchange) !== 'undefined') {
    checkbox.setAttribute('onchange', onchange);
  }
  set_value(checkbox, true);

  return tr;
}

function create_dialog_button(name, classname, action, payload) {
  var td = document.createElement('TD');
  var button = document.createElement('BUTTON');
  td.appendChild(button);

  button.setAttribute('type', 'button');
  button.setAttribute('class', classname);
  if (typeof(payload) !== 'undefined') {
    button.setAttribute('payload', payload);
  }
  button.onclick = action;
  button.innerText = name;

  return td;
}

// Called to display network config dialog
function ups_network_config_dialog_show() {
  if (has_class('dialog-box', 'hidden')) {
    // Call network manager to get current network config information.  When this
    // information arrives, process_network_config is called to continue the setup.

    send_gt('nm/list', function(results) {
      //
      // Called back with the current list of available connections and a detail of the
      // current connection:
      //   { 'selected': '<current connection>',
      //     'active': '<active ssid>',
      //     'mac_address': '<current device mac address>'
      //     'ipaddr': '<current ip address>'
      //     'known': { 'name': { 'ssid': '<ssid>', 'key': t/f }, ... },   // or 0 if no known connections
      //     'available': { 'ssid': { 'known': <t/f>, 'addr': '<mac addr>', 'key': <t/f> if key needed, 'sig': <sig strength in -dBm },
      //   }
      //

      // Get the regulatory country code list
      send_gt('config/attributes/network.regulatory', function(country_code_attributes) {

        var country_codes = country_code_attributes.options;

        add_class('main', 'dim');
    
        var config = document.getElementById('dialog-box');
    
        // Remove all children
        remove_children(config);
        config.setAttribute('class', 'config');
    
        // Construct inner div
        var config_div = document.createElement('DIV');
        //config_div.setAttribute('class', 'centered');
        config.appendChild(config_div);
    
        // Construct table on div
        var table = document.createElement('TABLE');
        table.setAttribute('class', 'center');
        config_div.appendChild(table);
    
        var tbody = document.createElement('TBODY');
        table.appendChild(tbody);
    
        // Create title
        tbody.appendChild(create_dialog_table_static('Network configuration'));
        tbody.appendChild(create_dialog_table_static(''))
     
        // Construct combo with available connections
        var available_list = [];
        for (var ap in results.available) {
          available_list.push([ ap, results.available[ap].key ]);
        }
    
        // Combo containing all available country codes
        tbody.appendChild(create_dialog_table_combo('Country',      'w-country', country_codes.sort()));
    
        // Combo containing all available access points
        tbody.appendChild(create_dialog_table_combo('Connections',  'w-connections', available_list.sort(), 'ups_network_config_connection_selected()'));
    
        // Construct rows in table for information
        tbody.appendChild(create_dialog_table_entry('Name',         'w-origname')).setAttribute('class', 'hidden');
    
        // Construct rows in table for information
        tbody.appendChild(create_dialog_table_entry('Name',         'w-name'));
    
        // Access Point
        tbody.appendChild(create_dialog_table_entry('SSID',         'w-ssid'));
    
        // Security type
        tbody.appendChild(create_dialog_table_combo('Security',     'w-security', [ 'Yes', 'No'], 'ups_network_config_security_selected()'));
    
        // Mode
        tbody.appendChild(create_dialog_table_entry('Key',          'w-key', 'password'));
    
        // Show pw visible button
        tbody.appendChild(create_dialog_table_checkbox('Show Key',  'w-showpw', 'ups_network_config_show_pw(this)', false));
    
        var buttontable = document.createElement('TABLE');
        buttontable.setAttribute('class', 'center');
        config_div.appendChild(buttontable);
        var buttonbody = document.createElement('TBODY');
        buttontable.appendChild(buttonbody);
    
        // Tack on Select, Delete, New and Cancel buttons
        var buttonrow = document.createElement('TR');
        buttonbody.appendChild(buttonrow);
    
        buttonrow.appendChild(create_dialog_button('Connect', 'dialog_button', ups_network_config_button_connect));
        buttonrow.appendChild(create_dialog_button('Delete',  'dialog_button', ups_network_config_button_delete));
        buttonrow.appendChild(create_dialog_button('Save', '   dialog_button', ups_network_config_button_save));
        buttonrow.appendChild(create_dialog_button('Cancel',  'dialog_button', ups_config_button_done));
    
        show_element('dialog-box');
    
        // Fish out the current connection details and pass to the dialog apply
        network_apply_details(results);
      });
    });
  }
}

function ups_network_config_security_selected() {
  set_enabled('w-key', get_value('w-security') === 'Yes');
}

function get_connection_dialog_info() {
  return {
    'oldname': get_value('w-origname'),
    'name': get_value('w-name'),
    'details': {
      'key': get_value('w-security') === 'Yes' ? get_value('w-key') : '',
      'ssid': get_value('w-ssid'),
    },
    'regulatory': get_value('w-country'),
  }
}

// Apply the details to the current network config dialoig
function network_apply_details(results) {

  var details = results.known[results.active];

  // Clear show-password status checkbox
  document.getElementById('w-key').setAttribute('type', 'password');
  set_value('w-showpw', false);

  if ('regulatory' in results) {
      set_value('w-country', results.regulatory);
  }
  set_value('w-origname', results.active);
  set_value('w-connections', results.active);
  set_value('w-name', results.active);
  set_enabled('w-name', results.active !== 'Hotspot');
  set_value('w-ssid', details.ssid);
  set_enabled('w-ssid', results.active === 'Hotspot');
  set_value('w-key', details.key);
  var key = parseInt(results.available[results.active].key);

  set_enabled('w-key', results.active === 'Hotspot' || key);
  set_value('w-security', key ? "Yes" : "No");
}

// The connection combo has been changed.  Request details for the connection.
function ups_network_config_connection_selected(list) {
  var connection = get_value('w-connections');
  var name = connection[0];
  var key = connection[1];

  send_gt('nm/connection/' + name, function(results) {
    if ('error' in results) {
      results = { 'ssid': name, 'key': '' }
    }
    // Apply details to dialog information
    var available = {};
    available[connection[0]] = { key: key }
    var known = {};
    known[name] = results;
    network_apply_details({ 'active': name, 'known': known, 'available': available });
  });
}


// Show/Hide password.
function ups_network_config_show_pw(item) {
  document.getElementById('w-key').setAttribute('type',  item.checked ? 'text' : 'password');
}

// Select the chosen connection and send to server
function ups_network_config_button_connect() {
  // Make sure we have a password if this is a secure mode connection.
  if (get_value('w-security') === 'Yes' && get_value('w-key') === '') {
    alert("Password required when security is enabled.")

  } else {
    // First try to save the data but ignore errors if found.
    send_gt('nm/save',
            function(results) {
              // Don't bother looking at results.  Might be an error or alert.

              // Now issue connect.
              send_gt('nm/connection/' + get_value('w-connections')[0],
                      function(connect_results) {
                        if ('error' in connect_results) {
                          alert(connect_results.error);
                        } else {
                          if ('alert' in results) {
                            alert(results.alert);
                          }
                          // Just close connection
                          ups_config_button_done();
                        }
                      },
                      null,
                     'put');
            },
            get_connection_dialog_info(),
            'post');
  }
}

// Delete the chosen connection and send to server (but ask first)
function ups_network_config_button_delete() {
  var connection = get_value('w-connections');

  // Raise an 'are you sure?' question
  if (confirm('Are you sure you wish to delete ' + connection[0])) {
     send_gt('nm/connection/' + connection[0],
             function(results) {
                if ('error' in results) {
                   alert(results['error']);
                } else {
                  if ('alert' in results) {
                     alert(results.alert);
                  }
                  ups_config_button_done();
                }
             },
             null,
             'delete');
  }
}

function ups_config_button_done() {
  hide_element('dialog-box');
  remove_class('main', 'dim');

  // Remove contents of dialog box
  remove_children(document.getElementById('dialog-box'));
}

function ups_network_config_button_save() {
  if (get_value('w-security') === 'Yes' && get_value('w-key') === '') {
    alert("Password required when security is enabled.")

  } else {
    send_gt('nm/save',
            function(results) {
              if ('error' in results) {
                alert(results.error);
              } else {
                if ('alert' in results) {
                  alert(results.alert);
                }
                ups_config_button_done();
              }
            },
            get_connection_dialog_info(),
            'post');
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.substr(1);
}

///////////////////////////////////////////////////////////////////////////////////////////////
// General purpose variable editor.
function ups_edit_configuration_dialog(varname, extra_info, buttons, action) {
  // Only raise if not in use
  if (has_class('dialog-box', 'hidden')) {

    send_gt('config/get/' + varname,
            function (varvalue) {
              if (! ('error' in varvalue)) {
                send_gt('config/attributes/' + varname,
                        function (attributes) {
                          if (! ('error' in attributes)) {
 
                            if (typeof(buttons) === 'undefined') {
                              buttons = [ 'Ok' ];
                            }

                            add_class('main', 'dim');

                            var config = document.getElementById('dialog-box');

                            // Remove all children
                            remove_children(config);
                            config.setAttribute('class', 'config');

                            // Construct inner div
                            var config_div = document.createElement('DIV');
                            config.appendChild(config_div);

                            // Construct table on div
                            var table = document.createElement('TABLE');
                            table.setAttribute('class', 'center');
                            config_div.appendChild(table);

                            var tbody = document.createElement('TBODY');
                            table.appendChild(tbody);

                            // Create title
                            tbody.appendChild(create_dialog_table_static(attributes['description']));
                            tbody.appendChild(create_dialog_table_static(''))
                            if (typeof(extra_info) !== 'undefined') {
                              tbody.appendChild(create_dialog_table_static(extra_info))
                              tbody.appendChild(create_dialog_table_static(''))
                            }

                            // Sort a list of var values if a dict of entries
                            if (varvalue.constructor === Object) {
                              // A dictionary of items (currently only single level supported.
                              // Create a list and sort
                              var value_names = [];

                              for (var name in varvalue) {
                                value_names.push(name);
                              }

                              value_names = value_names.sort();

                              for (var index in value_names) {
                                var name = value_names[index];
                                var attribute = attributes['fields'][name];
                                if ('options' in attribute) {
                                  // Create combo box
                                  tbody.appendChild(create_dialog_table_combo(capitalize(name), 'w-' + name, attribute['options'].sort(), null, varvalue[name]));
                                } else {
                                  // Just an entry item
                                  tbody.appendChild(create_dialog_table_entry(capitalize(name), 'w-' + name));
                                  set_value('w-' + name, varvalue[name]);
                                }
                              }
                            } else {
                              // A single value
                              if ('options' in attributes) {
                                // Create combo box
                                tbody.appendChild(create_dialog_table_combo(capitalize(name), 'w-' + name, attributes['options'].sort()));
                              } else {
                                // Just an entry item
                                tbody.appendChild(create_dialog_table_entry(capitalize(name), 'w-' + name));
                                set_value('w-' + name, varvalue[name]);
                              }
                            }

                            // Add the buttons
                            var buttontable = document.createElement('TABLE');
                            buttontable.setAttribute('class', 'center');
                            config_div.appendChild(buttontable);
                            var buttonbody = document.createElement('TBODY');
                            buttontable.appendChild(buttonbody);
    
                            // Tack on Select, Delete, New and Cancel buttons
                            var buttonrow = document.createElement('TR');
                            buttonbody.appendChild(buttonrow);
    
                            for (var index in buttons) {
                              var button = buttons[index];
                              buttonrow.appendChild(create_dialog_button(
                                                      button,
                                                      'dialog_button',
                                                      action,
                                                      value_names
                                                   )
                              );
                            }
    
                            show_element('dialog-box');
                          }
                        },
                );
            }
    });
  }
}

// Edit the default test parameters.  These get saved and are remembered over power off.
function ups_edit_configuration(params, extra_info, extra_writes) {
  ups_edit_configuration_dialog(params, extra_info,
                        [ 'Apply', 'Save', 'Cancel' ],
                        function(event) {
                          var values = event.target.attributes.payload.value.split(',');
                          // Process the button
                          if (event.target.innerText === 'Save' || event.target.innerText === 'Apply') {
                            var update_value = {};
                            update_value[params] = read_values(values);
                            if (typeof extra_writes !== 'undefined') {
                              for (index in extra_writes) {
                                update_value[extra_writes[index]] = update_value[params];
                              }
                            }
                            send_gt('config/apply',
                              function(results, values) {
                                if ('error' in results) {
                                  alert(results.error);
                                }

                                // Close dialog if 'Save'
                                if (event.target.innerText === 'Save') {
                                  // Close the  dialog
                                  ups_config_button_done();
                                }
                              },
                              update_value,
                              'post'
                            );
                          } else {
                            // Close the  dialog
                            ups_config_button_done();
                          }
                        }
  );
}

function read_values(values) {
  var results = {}
  for (var index in values) {
    var value = values[index];
    results[value] = get_value('w-' + value);
  }
  return results;
}


///////////////////////////////////////////////////////////////////////////////////////////////
function ups_change_password() {
  alert("Not implemented.")
}

///////////////////////////////////////////////////////////////////////////////////////////////
function ups_edit_users() {
  alert("Not implemented.")
}


// Send data
document.addEventListener('gt-send', function(event) {
  send_gt(event.detail);
});


// document access via callout table.
window['onload']                        = ups_initialize;
window['onunload']                      = ups_shutdown;
window['onresize']                      = ups_resize;

function showDropdown() {
  document.getElementById("dropdown-info").classList.toggle("hidden");
}

// Close the dropdown if the user clicks outside of it
window.onclick = function(event) {
  if (!event.target.matches('.dropdown-bar') && !event.target.matches('.dropdown-menu')) {
    var dropdowns = document.getElementsByClassName("dropdown-content");
    var i;
    for (i = 0; i < dropdowns.length; i++) {
      var openDropdown = dropdowns[i];
      if (! openDropdown.classList.contains('hidden')) {
        openDropdown.classList.toggle('hidden');
      }
    }
  }
}

