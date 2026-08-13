import os
import logging
import random
import re
import time
import urllib.parse
import secrets
import base64
import json
import qrcode
import io
from typing import Dict, Optional
import requests
import firebase_admin
from firebase_admin import credentials, db as rtdb
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardRemove
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- FIREBASE REALTIME DATABASE SETUP (RENDER SAFE) ---
firebase_config_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")

if firebase_config_json:
    try:
        cred_dict = json.loads(firebase_config_json)
        cred = credentials.Certificate(cred_dict)
        firebase_admin.initialize_app(cred, {
            'databaseURL': 'https://gbx-x-bb-default-rtdb.firebaseio.com/'
        })
        logging.info("Firebase initialized successfully from Environment Variable!")
    except Exception as e:
        logging.error(f"Firebase Env Init Error: {e}")
else:
    try:
        cred = credentials.Certificate("serviceAccountKey.json")
        firebase_admin.initialize_app(cred, {
            'databaseURL': 'https://gbx-x-bb-default-rtdb.firebaseio.com/'
        })
        logging.info("Firebase initialized using local serviceAccountKey.json")
    except Exception as e:
        logging.error(f"Firebase local init error: {e}")

# --- DEVICE SPOOFING & HEADERS ---
def _get_mock_location():
    lat = 26.154523 + random.uniform(-0.005000, 0.005000)
    lng = 85.891716 + random.uniform(-0.005000, 0.005000)
    return str(lat), str(lng)

def _random_device_id() -> str:
    return secrets.token_hex(8)

def _build_app_headers() -> dict:
    lat, lng = _get_mock_location()
    return {
        "user-agent": "Bigbasket-Android",
        "content-type": "application/json; charset=utf-8",
        "accept": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "version-code": "1590",
        "app-version": "6.17.0",
        "os-version": "14",
        "manufacturer": "VIVO",
        "model-name": "I2017",
        "swuid": _random_device_id(),
        "deviceid": _random_device_id(),
        "latitude": lat,
        "longitude": lng,
    }

def _build_headers(session: Dict) -> Dict[str, str]:
    h = {
        "user-agent": "Mozilla/5.0 (Linux; Android 14; I2017 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.5845.163 Mobile Safari/537.36",
        "content-type": "application/json",
        "client-id": "portal",
        "platform": "Bigbasket-Android",
        "x-requested-with": "in.bigbasket.android",
    }
    if session.get("tid"): h["tid"] = session["tid"]
    if session.get("token"): h["token"] = session["token"]
    if session.get("x-oztok"): h["x-oztok"] = session["x-oztok"]
    if session.get("sid"): h["sid"] = session["sid"]
    return h

# --- REAL BIGBASKET AUTH & API WRAPPERS ---
def bb_send_otp(phone: str):
    url = "https://www.bigbasket.com/member-tdl/v3/member/otp/"
    headers = _build_app_headers()
    payload = {"mobile": phone, "tag": "login"}
    try:
        res = requests.post(url, headers=headers, json=payload, timeout=10)
        if not res.text.strip():
            return {"status": "fail", "message": f"Server returned empty response (Status: {res.status_code})"}
        return res.json()
    except requests.exceptions.JSONDecodeError:
        return {"status": "fail", "message": "Non-JSON response from BigBasket"}
    except Exception as e:
        logging.error(f"BB Send OTP Error: {e}")
        return {"status": "fail", "message": str(e)}

def bb_verify_otp(phone: str, otp: str):
    url = "https://www.bigbasket.com/member-tdl/v3/member/unified-login/"
    headers = _build_app_headers()
    payload = {"mobile": phone, "otp": otp, "tag": "login"}
    try:
        res = requests.post(url, headers=headers, json=payload, timeout=10)
        return res.json(), res.cookies.get_dict()
    except Exception as e:
        logging.error(f"BB Verify OTP Error: {e}")
        return {"status": "fail"}, {}

def bb_get_cart_summary(session: dict):
    url = "https://www.bigbasket.com/mapi/v4.2.0/cart/summary/"
    headers = _build_headers(session)
    try:
        response = requests.get(url, headers=headers, timeout=10)
        return response.json()
    except Exception as e:
        return {"error": str(e)}

# --- USER MANAGEMENT HELPERS ---
def get_user_data(user_id: int):
    try:
        ref = rtdb.reference(f'users/{user_id}')
        data = ref.get()
        if data:
            return float(data.get('balance', 5.0)), float(data.get('points', 0.0))
        return 5.0, 0.0
    except Exception as e:
        logging.error(f"Error getting user data: {e}")
        return 5.0, 0.0

def update_balance(user_id: int, amount: float):
    try:
        ref = rtdb.reference(f'users/{user_id}')
        data = ref.get() or {'balance': 5.0, 'points': 0.0}
        new_bal = float(data.get('balance', 5.0)) + amount
        ref.update({'balance': new_bal})
    except Exception as e:
        logging.error(f"Error updating balance: {e}")

def update_points(user_id: int, points_to_add: float):
    try:
        ref = rtdb.reference(f'users/{user_id}')
        data = ref.get() or {'balance': 5.0, 'points': 0.0}
        new_pts = float(data.get('points', 0.0)) + points_to_add
        ref.update({'points': new_pts})
    except Exception as e:
        logging.error(f"Error updating points: {e}")

def is_user_banned(user_id: int) -> bool:
    try:
        return rtdb.reference(f'banned_users/{user_id}').get() is not None
    except Exception:
        return False

def get_all_user_ids():
    try:
        ref = rtdb.reference('users')
        users = ref.get()
        if users:
            return [int(uid) for uid in users.keys()]
        return []
    except Exception:
        return []

def is_utr_used(utr: str) -> bool:
    try:
        return rtdb.reference(f'used_utrs/{str(utr).strip()}').get() is not None
    except Exception:
        return False

def add_used_utr(utr: str):
    try:
        rtdb.reference(f'used_utrs/{str(utr).strip()}').set(True)
    except Exception:
        pass

def increment_tx_count(user_id: int) -> int:
    try:
        ref = rtdb.reference(f'users/{user_id}/tx_count')
        count = ref.get() or 0
        count += 1
        ref.set(count)
        return count
    except Exception:
        return 1

# --- CONFIGS ---
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", 8053042225))
BOT_TOKEN = "8791725918:AAEfdb0NlL7LFMYXzwD0LNjfZaWilJu_-Bk"

REQUIRED_TARGETS = [-1003332858806, -1003630519339, -1003197501531, -1003862251237]
TARGET_LINKS = {
    -1003332858806: "https://t.me/+6ByfGDRBKgsxMjZl",   
    -1003630519339: "https://t.me/+OWrCoeF-JutmNjg1",   
    -1003197501531: "https://t.me/+f2mWfDs6EUIxYTBl",   
    -1003862251237: "https://t.me/+O_-kEF2f5f1kMjdl"            
}
TARGET_LABELS = {
    -1003332858806: "📢 GBX LOOT", 
    -1003630519339: "📢 GBX EARN",
    -1003197501531: "📢 GBX ZONE", 
    -1003862251237: "💬 Join Group Chat (GC)"
}

USER_STATES = {}
PENDING_TX = {}
YOUR_UPI_ID = "BHARATPE.8R0I1G1N4X31943@fbpe" 
MERCHANT_NAME = "GBX"
bot_app = None

def load_dashboard_menu():
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("➕ New Login")],
        [KeyboardButton("💰 Balance"), KeyboardButton("👥 Refer & Earn")],
        [KeyboardButton("🛠️ Customer Care")]
    ], resize_keyboard=True)

async def get_remaining_channels(user_id: int):
    global bot_app
    remaining = []
    if not bot_app:
        return REQUIRED_TARGETS
    for target in REQUIRED_TARGETS:
        try:
            member = await bot_app.bot.get_chat_member(chat_id=target, user_id=user_id)
            if member.status in ['left', 'kicked', 'restricted']:
                remaining.append(target)
        except TelegramError:
            remaining.append(target)
    return remaining

async def show_force_join_menu(update: Update, remaining: list):
    buttons = []
    for target in remaining:
        buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
    buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
    total_left = len(remaining)
    await update.message.reply_text(f"⚠️ **Access Denied!**\n\nAbhi bhi `{total_left}` channels join karna baki hai:", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
    await update.message.reply_text("🔒 *Dashboard locked!*", reply_markup=ReplyKeyboardRemove())

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if is_user_banned(user_id):
        await update.message.reply_text("❌ Your account is banned from using this bot.")
        return

    args = context.args
    try:
        user_ref = rtdb.reference(f'users/{user_id}')
        user_data = user_ref.get()
        if not user_data:
            user_ref.set({'balance': 5.0, 'points': 0.0, 'tx_count': 0, 'username': update.effective_user.username or "N/A"})
            if args and args[0].isdigit():
                referrer_id = int(args[0])
                if referrer_id != user_id:
                    ref_check = rtdb.reference(f'referrals/{user_id}').get()
                    if not ref_check:
                        referrer_ref = rtdb.reference(f'users/{referrer_id}')
                        if referrer_ref.get():
                            rtdb.reference(f'referrals/{user_id}').set(referrer_id)
                            current_pts = float(referrer_ref.get().get('points', 0.0)) + 2.0
                            referrer_ref.update({'points': current_pts})
                            if bot_app:
                                try:
                                    await bot_app.bot.send_message(referrer_id, f"🎉 **New Referral!** You earned **2 Points**!", parse_mode="Markdown")
                                except Exception:
                                    pass
    except Exception as e:
        logging.error(f"Start error: {e}")

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return
    await update.message.reply_text("✨ **Dashboard Active!**\n🎁 Sign-up Bonus of ₹5 added to your balance!", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def admin_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_CHAT_ID:
        await update.message.reply_text("⚠️ Yeh command sirf admin ke liye hai!")
        return

    admin_markup = InlineKeyboardMarkup([
        [InlineKeyboardButton("📢 Broadcast", callback_data="adm_menu_broadcast")],
        [InlineKeyboardButton("👥 User List", callback_data="adm_menu_userlist"), InlineKeyboardButton("🚫 Ban ID", callback_data="adm_menu_ban")],
        [InlineKeyboardButton("✅ Unban ID", callback_data="adm_menu_unban")]
    ])
    await update.message.reply_text("🛠️ **Admin Control Panel:**", reply_markup=admin_markup, parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    
    remaining = await get_remaining_channels(user_id)
    if len(remaining) == 0:
        try:
            await query.message.delete()
        except Exception:
            pass
        await query.message.reply_text("✅ **Access Granted! Welcome.**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        buttons = []
        for target in remaining:
            buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
        buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
        await query.message.edit_text(f"⚠️ Bache hue `{len(remaining)}` channels join karein:", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if is_user_banned(user_id):
        return

    user_text = update.message.text
    document = update.message.document
    
    if document and document.file_name and document.file_name.endswith('.json'):
        try:
            file = await context.bot.get_file(document.file_id)
            file_bytes = await file.download_as_bytearray()
            json_data = json.loads(file_bytes.decode('utf-8'))
            phone = json_data.get('phone', 'ImportedAccount')
            acc_id = secrets.token_hex(4)
            rtdb.reference(f'accounts/{user_id}/{acc_id}').set(json_data)
            await update.message.reply_text(f"✅ **JSON Session Imported & Saved Successfully!**\nPhone: `{phone}`", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
            return
        except Exception:
            await update.message.reply_text("❌ Invalid JSON file format.")
            return

    if not user_text:
        return

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        USER_STATES[user_id] = None
        await show_force_join_menu(update, remaining)
        return

    if user_text in ["📱 My Accounts", "➕ New Login", "💰 Balance", "👥 Refer & Earn", "🛠️ Customer Care"]:
        USER_STATES[user_id] = None

    state = USER_STATES.get(user_id)

    if state == "AWAITING_BROADCAST":
        USER_STATES[user_id] = None
        if user_text.lower() == "cancel":
            await update.message.reply_text("❌ Broadcast cancelled.")
            return
        user_ids = get_all_user_ids()
        success, fail = 0, 0
        status_msg = await update.message.reply_text(f"🚀 Broadcasting to {len(user_ids)} users...")
        for uid in user_ids:
            try:
                await bot_app.bot.copy_message(chat_id=uid, from_chat_id=update.message.chat_id, message_id=update.message.message_id)
                success += 1
            except Exception:
                fail += 1
        await status_msg.edit_text(f"✅ **Broadcast Finished!**\n- Sent: {success}\n- Failed: {fail}")
        return

    elif state == "AWAITING_BAN_ID":
        USER_STATES[user_id] = None
        target_uid = user_text.strip()
        if target_uid.isdigit():
            rtdb.reference(f'banned_users/{target_uid}').set(True)
            await update.message.reply_text(f"🚫 User ID `{target_uid}` has been banned successfully.")
        else:
            await update.message.reply_text("❌ Invalid User ID number.")
        return

    elif state == "AWAITING_UNBAN_ID":
        USER_STATES[user_id] = None
        target_uid = user_text.strip()
        if target_uid.isdigit():
            rtdb.reference(f'banned_users/{target_uid}').delete()
            await update.message.reply_text(f"✅ User ID `{target_uid}` has been unbanned.")
        else:
            await update.message.reply_text("❌ Invalid User ID number.")
        return

    elif state == "AWAITING_AMOUNT":
        try:
            amount = float(user_text)
            if amount < 10.0:
                await update.message.reply_text("❌ Min ₹10 required.")
                return
            USER_STATES[user_id] = None
            tx_ref = f"GBX{user_id}X{random.randint(1000, 9999)}"
            PENDING_TX[user_id] = {"amount": amount, "tx_ref": tx_ref}
            
            raw_upi_string = f"upi://pay?pa={YOUR_UPI_ID}&pn={MERCHANT_NAME}&am={amount:.2f}&cu=INR&tr={tx_ref}"
            qr = qrcode.QRCode(version=1, box_size=10, border=4)
            qr.add_data(raw_upi_string)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            
            bio = io.BytesIO()
            bio.name = "qr.png"
            img.save(bio, "PNG")
            bio.seek(0)
            
            verify_btn = InlineKeyboardMarkup([[InlineKeyboardButton(text="🔄 Verify Payment (Enter UTR)", callback_data=f"ask_utr:{amount}")]])
            await update.message.reply_photo(photo=bio, caption=f"📲 Pay ₹{amount:.2f}\n⚠️ *Payment karke niche button par UTR daalein.*", reply_markup=verify_btn)
            return
        except ValueError:
            await update.message.reply_text("❌ Numeric amount daalein.")
            return

    elif state == "AWAITING_UTR" or re.match(r"^\d{12}$", user_text.strip()):
        utr = user_text.strip()
        if not re.match(r"^\d{12}$", utr):
            await update.message.reply_text("❌ Kripya sahi 12-digit ka UTR number bhejein.")
            return
        if is_utr_used(utr):
            await update.message.reply_text("❌ This UTR is already used!")
            return
            
        tx_data = PENDING_TX.get(user_id)
        amount = tx_data["amount"] if tx_data else 10.0
        USER_STATES[user_id] = None
        tx_count = increment_tx_count(user_id)
        
        if bot_app:
            admin_msg = f"📥 **Payment Request**\n👤 User ID: `{user_id}`\n🔢 UTR: `{utr}`\n💰 Amount: ₹{amount}"
            await bot_app.bot.send_message(
                chat_id=ADMIN_CHAT_ID,
                text=admin_msg,
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("✅ Accept", callback_data=f"adm_accept:{user_id}:{amount}:{utr}"),
                    InlineKeyboardButton("❌ Reject", callback_data=f"adm_reject:{user_id}:{utr}")
                ]]),
                parse_mode="Markdown"
            )
            await update.message.reply_text("⏳ **Payment Verification Pending!**")
        return

    elif state == "AWAITING_LOGIN_PHONE":
        phone = user_text.strip()
        if not re.match(r"^\d{10}$", phone):
            await update.message.reply_text("❌ Kripya valid 10-digit mobile number enter karein.")
            return
            
        res = bb_send_otp(phone)
        if res.get("status") == "success" or "otp" in str(res).lower() or res.get("success"):
            USER_STATES[user_id] = {"state": "AWAITING_LOGIN_OTP", "phone": phone}
            await update.message.reply_text(f"📨 OTP successfully sent to `{phone}` by BigBasket API!\n\nKripya 6-digit ka **OTP** enter karein:", parse_mode="Markdown")
        else:
            USER_STATES[user_id] = None
            await update.message.reply_text(f"❌ Failed to send OTP: {res.get('message', 'Unknown error')}")
        return

    elif isinstance(state, dict) and state.get("state") == "AWAITING_LOGIN_OTP":
        otp = user_text.strip()
        phone = state.get("phone")
        USER_STATES[user_id] = None
        
        verify_res, cookies = bb_verify_otp(phone, otp)
        token = cookies.get("sessionid", cookies.get("token", f"bb_token_{secrets.token_hex(12)}"))
        tid = cookies.get("tid", f"bb_tid_{secrets.token_hex(16)}")
        
        acc_id = secrets.token_hex(4)
        session_data = {
            'phone': phone,
            'token': token,
            'tid': tid,
            'cookies': cookies
        }
        rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_data)
        
        await update.message.reply_text(f"✅ **Account Login Successful!**\nPhone: `{phone}`\nSession saved to My Accounts.", parse_mode="Markdown", reply_markup=load_dashboard_menu())
        return

    if user_text == "💰 Balance":
        current_bal, current_pts = get_user_data(user_id)
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(f"💳 **Balance:** `₹{current_bal:.2f}`\n⭐ **Points:** `{current_pts:.1f}`\n\n📥 Enter amount to deposit (Min ₹10):", parse_mode="Markdown")
    elif user_text == "👥 Refer & Earn":
        bot_username = context.bot.username
        ref_link = f"https://t.me/{bot_username}?start={user_id}"
        _, current_pts = get_user_data(user_id)
        ref_text = f"👥 **Refer & Earn**\n\n🔗 Link:\n`{ref_link}`\n\n⭐ Points: **{current_pts:.1f}**"
        await update.message.reply_text(ref_text, parse_mode="Markdown")
    elif user_text == "🛠️ Customer Care":
        support_keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("💬 Open Support Mini Web", url="https://t.me/gbx_support_bot")]])
        await update.message.reply_text("🛠️ Click below to open Customer Care Mini App / Support:", reply_markup=support_keyboard)
    elif user_text == "📱 My Accounts":
        accs = rtdb.reference(f'accounts/{user_id}').get() or {}
        if accs:
            acc_list_text = f"📱 **Your Saved Accounts ({len(accs)}):**\n\n"
            keyboard_buttons = []
            for idx, (acc_key, acc_val) in enumerate(accs.items(), 1):
                phone = acc_val.get('phone', 'N/A')
                acc_list_text += f"{idx}. 📞 `{phone}`\n"
                keyboard_buttons.append([InlineKeyboardButton(f"📤 Export ({phone})", callback_data=f"export_auth:{user_id}:{acc_key}")])
            await update.message.reply_text(acc_list_text, reply_markup=InlineKeyboardMarkup(keyboard_buttons), parse_mode="Markdown")
        else:
            await update.message.reply_text(f"🆔 **Your Telegram ID:** `{user_id}`\n\n📌 *No accounts found. Click '➕ New Login' or send account JSON file.*", parse_mode="Markdown")
    elif user_text == "➕ New Login":
        USER_STATES[user_id] = "AWAITING_LOGIN_PHONE"
        await update.message.reply_text("📱 **Send your BigBasket Mobile Number (10-digit)**\n*(Or you can directly upload your .json session file here in chat)*", parse_mode="Markdown")
    else:
        await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu())

async def admin_action_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global bot_app
    query = update.callback_query
    if query:
        await query.answer()
        data = query.data.split(":")
        
        if data[0] == "adm_menu_broadcast":
            USER_STATES[query.from_user.id] = "AWAITING_BROADCAST"
            cancel_btn = InlineKeyboardMarkup([[InlineKeyboardButton("❌ Cancel", callback_data="adm_cancel")]])
            await query.message.reply_text("📢 Kuch bhi message ya sticker bhejein jo sabhi users ko broadcast karna ho:\n*(Ya 'cancel' type karein)*", reply_markup=cancel_btn)
            return
        elif data[0] == "adm_menu_userlist":
            users = rtdb.reference('users').get() or {}
            user_str = f"👥 **Total Users: {len(users)}**\n\n"
            for uid, udata in list(users.items())[:35]:
                uname = udata.get('username', 'N/A')
                user_str += f"🆔 `{uid}` | @{uname}\n"
            await query.message.reply_text(user_str, parse_mode="Markdown")
            return
        elif data[0] == "adm_menu_ban":
            USER_STATES[query.from_user.id] = "AWAITING_BAN_ID"
            await query.message.reply_text("🚫 Jise ban karna hai uska **User ID** type karein:")
            return
        elif data[0] == "adm_menu_unban":
            USER_STATES[query.from_user.id] = "AWAITING_UNBAN_ID"
            await query.message.reply_text("✅ Jise unban karna hai uska **User ID** type karein:")
            return
        elif data[0] == "adm_cancel":
            USER_STATES[query.from_user.id] = None
            await query.message.reply_text("❌ Action cancelled.")
            return

        if data[0] == "export_auth":
            target_user = int(data[1])
            acc_key = data[2]
            acc_data = rtdb.reference(f'accounts/{target_user}/{acc_key}').get()
            if acc_data:
                json_str = json.dumps(acc_data, indent=2)
                bio = io.BytesIO(json_str.encode('utf-8'))
                bio.name = f"session_{acc_data.get('phone', 'account')}.json"
                bio.seek(0)
                await query.message.reply_document(document=bio, caption=f"📁 **Auth Exported**")
            return

        action, target_user = data[0], int(data[1])
        utr = data[3] if len(data) > 3 else "N/A"
        if utr != "N/A":
            add_used_utr(utr)

        if action == "adm_accept":
            amount = float(data[2])
            update_balance(target_user, amount) 
            PENDING_TX.pop(target_user, None)
            await query.message.edit_text(f"✅ Approved! ₹{amount} added to User `{target_user}`.")
            if bot_app:
                try:
                    await bot_app.bot.send_message(target_user, f"🎉 **Payment Verified!** ₹{amount} added to balance.")
                except Exception:
                    pass
        elif action == "adm_reject":
            PENDING_TX.pop(target_user, None)
            await query.message.edit_text(f"❌ Rejected request for User `{target_user}`.")
            if bot_app:
                try:
                    await bot_app.bot.send_message(target_user, "⌛ **Payment Rejected!** Invalid UTR.")
                except Exception:
                    pass

async def prompt_utr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    USER_STATES[user_id] = "AWAITING_UTR"
    await query.message.delete()
    await query.message.reply_text("📝 **Ab 12-digit ka UTR Number type karke bhejein:**", parse_mode="Markdown")

# --- FASTAPI SERVER ---
api_app = FastAPI()

@api_app.get("/")
def home():
    return JSONResponse({"status": "ok", "service": "GBX Bot Server Running"})

@api_app.on_event("startup")
async def startup_event():
    global bot_app
    TOKEN = BOT_TOKEN
    if TOKEN:
        try:
            bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
            bot_app.add_handler(CommandHandler("start", start))
            bot_app.add_handler(CommandHandler("admin", admin_command))
            bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
            bot_app.add_handler(CallbackQueryHandler(prompt_utr, pattern="ask_utr:.*"))
            bot_app.add_handler(CallbackQueryHandler(admin_action_handler, pattern="adm_.*|export_auth:.*"))
            bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.ALL & ~filters.COMMAND, handle_text_messages))
            
            await bot_app.initialize()
            await bot_app.start()
            logging.info("Main bot initialized successfully with full features.")
        except Exception as e:
            logging.error(f"Bot init error: {e}")

@api_app.post("/webhook")
async def receive_telegram_update(request: Request):
    global bot_app
    if bot_app:
        data = await request.json()
        await bot_app.process_update(Update.de_json(data, bot_app.bot))
    return Response(status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(api_app, host="0.0.0.0", port=port)
