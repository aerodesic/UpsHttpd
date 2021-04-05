#!/usr/bin/python3

from secret_key import *

import traceback
import time
import dbus
import syslog
import os
import json
import uuid
from copy import deepcopy

from flask import Flask, request, jsonify, render_template, g, url_for, redirect, abort, flash, Response
from flask_restful import Resource, fields, marshal_with, Api, reqparse
from flask_login import LoginManager, UserMixin, current_user, login_user, logout_user, login_required
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.contrib.fixers import LighttpdCGIRootFix
from werkzeug.utils import secure_filename

from aoutils.utils import GetHomeDir
from flup.server.fcgi import WSGIServer


_BUSNAME = "com.robosity.upscontrol.control"
_SERVICENAME = "/com/robosity/upscontrol/control"

UPLOAD_FOLDER = '/home/vc/software_updates'
ALLOWED_EXTENSIONS = set(['zip'])

_DEFAULT_USERNAME = 'admin'
_DEFAULT_PASSWORD = 'secret'
_DEFAULT_PERMISSIONS = 'administrator'
_USER_PERMISSIONS = [ 'administrator', 'therapist', 'none' ]
_VCOACH_USER_DATABASE_FILE = '/home/vc/.vcoach.users'

# The main database dictionary { 'name' :<properties> }
_user_database_by_name = {}

# A mapping from <id> to <name>  { 'id': <name> }
_user_name_by_id = {}

# User manipulation functions
def _load_user_database():
    global _user_database_by_name, _user_name_by_id

    # Try preloading the user database
    try:
        f = open(_VCOACH_USER_DATABASE_FILE, 'r')
        _user_database_by_name = json.load(f)
        f.close()

    except:
        _add_user(_DEFAULT_USERNAME, _DEFAULT_PASSWORD, _DEFAULT_PERMISSIONS)
        # Debug - add ordinary user
        # _add_user('therapist', 'simple', 'therapist')
        # _add_user('normal', 'ugly', 'none')
        _save_user_database()

    finally:
        # Create inverted table by user id (re-do some of the work in _add_user, but who cares?
        _user_name_by_id = {}
        for username in _user_database_by_name:
            _user_name_by_id[_user_database_by_name[username]['id']] = username

def _add_user(username, password, permissions):
    global _user_database_by_name, _user_name_by_id
    results = None

    if username not in _user_database_by_name:
        new_id = str(uuid.uuid4()).replace('-','')
        _user_database_by_name[username] = {
            'password': generate_password_hash(password),
            'permissions': permissions,
            'id': new_id,
        }
        _user_name_by_id[new_id] = username

        _save_user_database()

    else:
        results = "User %s already exists" % username

    return results


def _delete_user(userid, save=True):
    global _user_database_by_name, _user_name_by_id

    if userid in _user_name_by_id:
        username = _user_name_by_id[userid]
        del (_user_name_by_id[userid])
        del (_user_database_by_name[username])
        if save:
            _save_user_database()

#
# Edit a user and change any field
#
def _change_user(userid, username=None, password=None, permissions=None):
    global _user_name_by_id
    global _user_database_by_name

    # If a valid user...
    if userid in _user_name_by_id:
        new_username = _user_name_by_id[userid]

        # Grab copy of the user
        user = deepcopy(_user_database_by_name[new_username])

        changed = False
        if username != None:
            # Save under new name
            new_username = username

        if password != None:
            # Change password
            user['password'] = generate_password_hash(password)
            changed = True

        if permissions != None:
            # Change permissions
            user['permissions'] = permissions
            changed = True

        if changed:
            # Delete old users in the database
            _delete_user(userid, save=False)

            # Create the new user
            _user_name_by_id[userid] = new_username
            _user_database_by_name[new_username] = user
            _save_user_database()

def _save_user_database():
    try:
        f = open(_VCOACH_USER_DATABASE_FILE, 'w')
        f.write(json.dumps(_user_database_by_name, indent=3, sort_keys=True) + '\n')
        f.close()

    except:
        pass


class User(UserMixin):
    def __init__(self, id):
        if id in _user_name_by_id:
            self._id = id

        else:
            self._id = None

    # Static function for looking up user by name and password
    def lookup(username, password):
        user = None

        id = User.check_password(username, password)
        if id != None:
            user = User(id)

        return user

    # Static function to check a password and return id if found else none
    def check_password(username, password):
        id = None

        if username in _user_database_by_name:
            if check_password_hash(_user_database_by_name[username]['password'], password):
                if 'id' in _user_database_by_name[username]:
                    id = _user_database_by_name[username]['id']
         
        return id

    # Method to change a password
    def change_password(self, oldpw, newpw):
        results = None

        username = self.username()

        if User.check_password(username, oldpw) != None:
            _user_database_by_name[username]['password'] = generate_password_hash(newpw)
        else:
            results = "Incorrect password."

        return results

    def _get_user_database(self):
        username = _user_name_by_id[self._id] if self._id in _user_name_by_id else None
        return _user_database_by_name[username] if username in _user_database_by_name else {}

    def is_administrator(self):
        database = self._get_user_database()
        return "administrator" == database['permissions'] if 'permissions' in database else False

    def is_therapist(self):
        database = self._get_user_database()
        return "therapist" == database['permissions'] if 'permissions' in database else False

    def get_id(self):
        return self._id

    def is_authenticated(self):
        return self._id != None

    def is_anonymous(self):
        return False

    def username(self):
        return  _user_name_by_id[self._id] if self._id in _user_name_by_id else None

    def permissions(self):
        database = self._get_user_database()
        return database['permissions'] if 'permissions' in database else "None"

    def __repr__(self):
        username = self.username()
        return "%s(%s)" % (self._id, username if username != None else "***UNKNOWN***")

# Connect to upscontrol and return the access path
def _connect_to_erver():

    service = None

    while service == None:
        try:
            bus = dbus.SystemBus()
            service = bus.get_object(_BUSNAME, _SERVICENAME)

        except:
            service = None
            syslog.syslog("Waiting for upscontrol server...")
            time.sleep(1)

    syslog.syslog('upscontrol server is up')

    return service

upscontrolservice = _connect_to_server()

SendMsg              = upscontrolservice.get_dbus_method('SendMsg',               _BUSNAME)   # post
GetStatus            = upscontrolservice.get_dbus_method('GetStatus',             _BUSNAME)   # get
GetValue             = upscontrolservice.get_dbus_method('GetValue',              _BUSNAME)   # get
SetValue             = upscontrolservice.get_dbus_method('SetValue',              _BUSNAME)   # put
ApplyValues          = upscontrolservice.get_dbus_method('ApplyValues',           _BUSNAME)   # put
HttpRequest          = upscontrolservice.get_dbus_method('HttpRequest',           _BUSNAME)   # post
NetManagerRequest    = upscontrolservice.get_dbus_method('NetManagerRequest',     _BUSNAME)   # varies
ResetRequest         = upscontrolservice.get_dbus_method('Reset',                 _BUSNAME)   # get
RebootRequest        = upscontrolservice.get_dbus_method('Reboot',                _BUSNAME)   # get
ShutdownRequest      = upscontrolservice.get_dbus_method('Shutdown',              _BUSNAME)   # get

class ResetClass(Resource):
    decorators = [ login_required ]

    def get(self):
        # Only permitted for administrator
        if g.user.is_administrator():
            return ResetRequest()
        else:
            return { 'error': 'Not permitted' }

class RebootClass(Resource):
    decorators = [ login_required ]

    def get(self):
        # Only permitted for administrator
        if g.user.is_administrator():
            return RebootRequest()
        else:
            return { 'error': 'Not permitted' }

class ShutdownClass(Resource):
    decorators = [ login_required ]

    def get(self):
        # Only permitted for administrator
        if g.user.is_administrator():
            return ShutdownRequest()
        else:
            return { 'error': 'Not permitted' }

sendmsg_parser = reqparse.RequestParser()
sendmsg_parser.add_argument('command', required=True)
sendmsg_parser.add_argument('to', required=False)
sendmsg_parser.add_argument('reply', required=False)

class SendMsgClass(Resource):
    decorators = [ login_required ]

    def post(self, **kwargs):
        args = sendmsg_parser.parse_args()
        if args['reply'] == None:
            del(args['reply'])
        # print("SendMsg.post: args %s" % args)
        return SendMsg(**args)

# Get or Set a value
class GetValueClass(Resource):
    decorators = [ login_required ]

    def get(self, var):
        return GetValue(var, True)

class SetValueClass(Resource):
    decorators = [ login_required ]

    def put(self, var, value):
        return SetValue(var, value)

class ApplyValuesClass(Resource):
    decorators = [ login_required ]

    # Do an 'apply' to any values into configuration
    def put(self, **kwargs):
        return ApplyValues()

http_request_parser = reqparse.RequestParser()
http_request_parser.add_argument('url', required=True)
http_request_parser.add_argument('type')
http_request_parser.add_argument('data')
http_request_parser.add_argument('json')

class HttpRequestClass(Resource):
    decorators = [ login_required ]

    def post (self, **kwargs):
        args = http_request_parser.parse_args()

        data     = '' if args['data'] == None else args['data']
        jsondata = '' if args['json'] == None else args['json']

        if isinstance(jsondata, str):
            jsondata = eval(jsondata)

        return HttpRequest(args['url'], args['type'], data, jsondata)

# network_manager operations:
#  { 'command': 'list' }  - list current available connections:
#
# NetManagerConnectionClass values:
#
#  { 'command': 'connect', 'data': '<connection name>' } - select connection for operation
#         { 'ok': true } or { 'error': '<error message>' }
#
#  { 'command': 'delete', 'data': '<connection name>' } - delete a connection
#         { 'ok': true } or { 'error': '<error message>' }
#
# NetManagerSaveClass:
#
#  { 'command': 'save', 'data': { 'old_name': '<old connection name>', 'name': '<new name>', 'details': <connection details>' } - save a new connection
#         { 'ok': true } or { 'error': '<error message>' }

network_available_details = {
    'addr':   fields.String,
    'key':    fields.String,
    'sig':    fields.Float,
    'known':  fields.Boolean,
}

network_known_details = {
    'ssid':   fields.String,
    'key':    fields.Boolean,
}

network_manager_list_fields = {
    'available': fields.Nested(network_available_details),
    'known': fields.Nested(network_known_details),
    'active': fields.String,
    'selected': fields.String,
    'mac_address': fields.String,
    'ipaddr': fields.String,
}

class NetManagerListClass(Resource):
    decorators = [ login_required ]

    # @marshal_with(network_manager_list_fields)
    def get (self):
        return NetManagerRequest('list', '')

#
# Retrieve, set or delete data from current connection list.
#
class NetManagerConnectionClass(Resource):
    decorators = [ login_required ]

    # Get information about the specified connection name
    def get(self, connection):
        return NetManagerRequest('details', connection)

    # Delete the specified connection name data
    def delete(self, connection):
        return NetManagerRequest('delete', connection)

    # Connect to the specified connection using saved credentials if found in the
    # known-connection list or use an 'open' connection if destination is not encrypted
    # (in which case the connection will be remembered in the known-connection list.)
    def put(self, connection):
        return NetManagerRequest('connect', connection)


class NetManagerSaveClass(Resource):
    decorators = [ login_required ]

    def post(self, **kwargs):
        args = request.get_json(force=True)
        return NetManagerRequest('save', str(args))

# Create the app
app = Flask(__name__)
app.wsgi_app = LighttpdCGIRootFix(app.wsgi_app)
app.config['SECRET_KEY'] = SECRET_KEY
app.config['DEBUG'] = True
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

api = Api(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"

@app.before_request
def before_request():
    g.user = current_user


@app.route('/index', methods=["GET"])
@app.route('/', methods=["GET"])
@login_required
def home():
    try:
        return render_template('index.html', vconline=GetConfigValue('network.vconline', True))

    except Exception as e:
        syslog.syslog("Home render %s" % str(e))


@app.route('/vc.fcgi/', methods=["GET"])   # Something is letting this leak through - redirect it
@app.route('/vc.fcgi', methods=["GET"])   # Something is letting this leak through - redirect it
def home2():
    return redirect('/')

@app.route('/login', methods=['GET','POST'])
def login():
    results = None

    try:
        if request.method == 'GET':
            results = render_template('login.html')

        elif request.method == 'POST':
            username = request.form['username']
            password = request.form['password']
            syslog.syslog("login: username '%s'" % username)

            registered_user = User.lookup(username=username, password=password)

            if registered_user is not None:
                login_user(registered_user)
                next = request.args.get('next')

                # The name of the fcgi script is leaking through as next.  Kill it.
                if not next or next == 'vc.fcgi':
                    next = '/'

                results = redirect(next)

            else:
                results = render_template('login.html', error_message="Bad password, Try again.")

    except Exception as e:
        syslog.syslog("login exception: %s" % str(e))
        syslog.syslog(traceback.print_exc())

    return results if results != None else abort(401)

@app.route('/logout', methods=["GET"])
@login_required
def logout():
    logout_user()
    return redirect(url_for('home'))

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/software_update', methods=['GET', 'POST'])
@login_required
def software_update():
    results = None

    # Only allowed by administrators
    if g.user.is_administrator():
        if request.method == 'POST':
            # check if the post request has the file part
            if 'file' not in request.files:
                flash('No file part')
                results = redirect(request.url)

            file = request.files['file']
            # if user does not select file, browser also
            # submit an empty part without filename

            if file.filename == '':
                flash('No selected file')
                results = redirect(request.url)

            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                upload_folder = app.config['UPLOAD_FOLDER']
                if not os.path.exists(upload_folder):
                    os.makedirs(upload_folder)

                file.save(os.path.join(upload_folder, filename))
                results =  render_template('uploaded_file.html', filename=filename)

        elif request.method == 'GET':
            results = render_template('software_update.html')

    else:
        flash("Insufficient permissions.")

    # Bogus action - redirect to home page
    if results == None:
        results = redirect(url_for('home'))

    return results


# handle login failed
@app.errorhandler(401)
def page_not_found(e):
    return Response('<p>Login failed</p>')


# callback to reload the user object
@login_manager.user_loader
def load_user(userid):
    return User(userid)

@app.route('/change_password', methods=['GET', 'POST'])
@login_required
def change_password():
    results = None

    try:
        if request.method == 'POST':

            # Make sure both passwords are the same
            if request.form['newpw1'] != request.form['newpw2']:
                results = render_template("change_password.html", error_message="Passwords are different.")
        
            else:
                error = g.user.change_password(request.form['oldpw'], request.form['newpw1'])
                if error:
                    results = render_template('change_password.html', error_message=error)

                else:
                    results = redirect(url_for('home'))
            
        elif request.method == 'GET':
            results = render_template('change_password.html')

    except Exception as e:
        syslog.syslog("change_password exception %s" % e)
        results = render_template('change_password.html', error_message=e)

    return results


#
# Creates a list of users.  Operator can select Edit or Del or a global New User action.
#
@app.route('/edit_users', methods=["GET", "POST"])
@login_required
def edit_users():
    results = None

    if g.user.is_administrator():
        if request.method == 'GET':
            results = render_template('edit_users.html', users=_user_database_by_name)

        elif request.method == 'POST':
            if request.form['action'] == 'add':
                # This will be a new-user request
                results = redirect(url_for('new_user'))
            else:
                results = redirect(url_for('home'))

    else:
        flash("Insufficient permissions.")

    # Bogus action - redirect to home page
    if results == None:
        results = redirect(url_for('home'))

    return results


#
# Action of creating a user.
#
@app.route('/new_user', methods=["GET", "POST"])
@login_required
def new_user():
    results = None

    if g.user.is_administrator():
        if request.method == 'GET':
            results = render_template('new_user.html', permissions=_USER_PERMISSIONS)

        elif request.method == 'POST':
            # Post the change if accepted
            if request.form['action'] == 'save':

                username = request.form['username'] 
                password = request.form['newpw1']
                password2 = request.form['newpw2']
                permissions = request.form['permissions']

                if username == "":
                    results = render_template("new_user.html", error_message="User name required", permissions=_USER_PERMISSIONS)

                elif password == "" or password2 == "":
                    results = render_template("new_user.html", error_message="Password is required", permissions=_USER_PERMISSIONS)

                elif password != password2:
                    results = render_template("new_user.html", error_message="Passwords are different", permissions=_USER_PERMISSIONS)

                else:
                    error = _add_user(username, password, permissions)

                    if error:
                        results = render_template("new_user.html", error_message=error, permissions=_USER_PERMISSIONS)

                    else:
                        results = redirect(url_for("edit_users"))
            else:
                results = redirect(url_for("edit_users"))

    else:
        flash("Insufficient permissions.")

    # Bogus action - redirect to home page
    if results == None:
        results = redirect(url_for('home'))

    return results


#
# Action of editing a user.
#
@app.route('/edit_user', methods=["GET", "POST"])
@login_required
def edit_user():
    results = None

    if g.user.is_administrator():
        if request.method == 'GET':
            userid = request.args['userid']
            results = render_template('edit_user.html', user=User(userid), permissions=_USER_PERMISSIONS)

        elif request.method == 'POST':
            # Post the change if accepted
            if request.form['action'] != 'cancel':
                userid = request.form['action']

                if request.form['newpw1'] != request.form['newpw2']:
                    results = render_template("edit_user.html", error_message="Passwords are different.", user=User(userid), permissions=_USER_PERMISSIONS)

                else:
                    new_password = request.form['newpw1']
                
                    _change_user(userid, password=new_password, permissions=request.form['permission'])

                    results = redirect(url_for("edit_users"))

    else:
        flash("Insufficient permissions.")

    # Bogus action - redirect to home page
    if results == None:
        results = redirect(url_for('home'))

    return results


#
# Action of deleting a user.
#
@app.route('/delete_user', methods=["GET", "POST"])
@login_required
def delete_user():
    results = None

    if g.user.is_administrator():
        if request.method == 'GET':
            userid = request.args['userid']

            syslog.syslog("delete_user: userid %s" % userid)

            if userid == g.user.get_id():
                results = render_template('edit_users.html', users=_user_database_by_name, error_message="Cannot delete logged in user")

            else:
                results = render_template('delete_user.html', user=User(userid))

        elif request.method == 'POST':
            if request.form['action'] != 'cancel':
                # Value of button as user id
                _delete_user(request.form['action']);

            results = render_template('edit_users.html', users=_user_database_by_name)

    else:
        flash("Insufficient permissions.")

    # Bogus action - redirect to home page
    if results == None:
        results = redirect(url_for('home'))

    return results


@app.route('/rebooting', methods=["GET"])
def rebooting():
    return render_template('shutdown.html', reason="reboot")

@app.route('/poweroff', methods=["GET"])
def poweroff():
    return render_template('shutdown.html', reason="shutdown")

# Reboot and shutdown
api.add_resource(ResetClass,                    "/rest/reset",                                  endpoint='reset')
api.add_resource(RebootClass,                   "/rest/reboot",                                 endpoint='reboot')
api.add_resource(ShutdownClass,                 "/rest/shutdown",                               endpoint='shutdown')

# Send a general message to a task on the controller
api.add_resource(SendMsgClass,                  "/rest/sendmsg",                                endpoint='sendmsg')

# Return current status
api.add_resource(StatusClass,                   "/rest/status",                                 endpoint='status')

# Retrieve or change configuration
api.add_resource(GetValueClass,                 "/rest/value/get/<string:var>",                 endpoint='get_value')
api.add_resource(SetValueClass,                 "/rest/value/set/<string:var><string:value>",   endpoint='set_value')
api.add_resource(ApplyValuesClass,              "/rest/value/apply",                            endpoint='apply_values')

# A request to the vc to issue a request to the vconline server.
api.add_resource(HttpRequestClass,              "/rest/httprequest",                            endpoint='httprequest')

# Add connections to the vcserver NetManager thread
api.add_resource(NetManagerListClass,           "/rest/nm/list",                                endpoint='nm_list')
api.add_resource(NetManagerConnectionClass,     "/rest/nm/connection/<string:connection>",      endpoint='nm_connection')
api.add_resource(NetManagerSaveClass,           "/rest/nm/save",                                endpoint='nm_save')


_load_user_database()

if __name__ == '__main__':
    syslog.syslog('starting app')
    WSGIServer(app).run()
    syslog.syslog('app stopped')

