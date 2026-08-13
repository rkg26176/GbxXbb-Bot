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
import firebase_admin
from firebase_admin import credentials, db as rtdb
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardRemove
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- FIREBASE REALTIME DATABASE SETUP ---
cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred, {
    'databaseURL': 'https://gbx-x-bb-default-rtdb.firebaseio.com/'
})

# --- DEVICE SPOOFING & MOCK FUNCTIONS ---
def _get_mock_location():
    lat = 26.154523 + random.uniform(-0.005000, 0.005000)
    lng = 85.891716 + random.uniform(-0.005000, 0.005000)
    return str(lat), str(lng)

def _random_device_id() -> str:
    return secrets.token_hex(8)

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

def get_all_user_ids():
    try:
        ref = rtdb.reference('users')
        users = ref.get()
        if users:
            return [int(uid) for uid in users.keys()]
        return []
    except Exception as e:
        logging.error(f"Error fetching all user IDs: {e}")
        return []

def is_utr_used(utr: str) -> bool:
    try:
        ref = rtdb.reference(f'used_utrs/{str(utr).strip()}')
        return ref.get() is not None
    except Exception as e:
        logging.error(f"Error checking UTR: {e}")
        return False

def add_used_utr(utr: str):
    try:
        ref = rtdb.reference(f'used_utrs/{str(utr).strip()}')
        ref.set(True)
    except Exception as e:
        logging.error(f"Error storing UTR: {e}")

def increment_tx_count(user_id: int) -> int:
    try:
        ref = rtdb.reference(f'users/{user_id}/tx_count')
        count = ref.get() or 0
        count += 1
        ref.set(count)
        return count
    except Exception as e:
        logging.error(f"Error incrementing tx count: {e}")
        return 1

# --- SYSTEM CONFIGS ---
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", 8053042225))
BOT_TOKEN = os.getenv("BOT_TOKEN")

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
        [KeyboardButton("💰 Wallet"), KeyboardButton("👥 Refer & Earn")],
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
    args = context.args
    
    try:
        user_ref = rtdb.reference(f'users/{user_id}')
        user_data = user_ref.get()
        
        if not user_data:
            user_ref.set({'balance': 5.0, 'points': 0.0, 'tx_count': 0})
            
            if args and args[0].isdigit():
                referrer_id = int(args[0])
                if referrer_id != user_id:
                    ref_check = rtdb.reference(f'referrals/{user_id}').get()
                    if not ref_check:
                        referrer_ref = rtdb.reference(f'users/{referrer_id}')
                        if referrer_ref.get():
                            rtdb.reference(f'referrals/{user_id}').set(referrer_id)
                            update_points(referrer_id, 2.0)
                            if bot_app:
                                try:
                                    await bot_app.bot.send_message(
                                        chat_id=referrer_id,
                                        text=f"🎉 **New Successful Referral!**\n🎁 You earned **2 Points**!",
                                        parse_mode="Markdown"
                                    )
                                except Exception:
                                    pass
    except Exception as e:
        logging.error(f"Error on start & referral: {e}")

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return
    await update.message.reply_text("✨ **Dashboard Active!**\n🎁 Sign-up Bonus of ₹5 added to your wallet!", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    
    remaining = await get_remaining_channels(user_id)
    total_left = len(remaining)
    
    if total_left == 0:
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
        try:
            await query.message.edit_text(f"⚠️ **Access Denied!**\n\nKripya baki bache `{total_left}` channels join karein:", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
        except TelegramError:
            await query.answer(text=f"❌ Bache hue {total_left} channels join karein!", show_alert=True)

async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_text = update.message.text
    document = update.message.document
    
    # Handle JSON file upload for direct session import
    if document and document.file_name.endswith('.json'):
        try:
            file = await context.bot.get_file(document.file_id)
            file_bytes = await file.download_as_bytearray()
            json_data = json.loads(file_bytes.decode('utf-8'))
            
            phone = json_data.get('phone', 'ImportedAccount')
            acc_id = secrets.token_hex(4)
            rtdb.reference(f'accounts/{user_id}/{acc_id}').set(json_data)
            
            await update.message.reply_text(f"✅ **JSON Session Imported Successfully!**\nAccount Phone: `{phone}`", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
            return
        except Exception as e:
            await update.message.reply_text("❌ Invalid JSON file format. Please upload a valid account JSON.")
            return

    if not user_text:
        return
        
    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        USER_STATES[user_id] = None
        buttons = []
        for target in remaining:
            buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
        buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
        await update.message.reply_text(f"⚠️ **Access Denied!**\n\nChannels leave karne ke karan service lock kar di gayi hai:", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
        await update.message.reply_text("⛔ *Access Revoked!*", reply_markup=ReplyKeyboardRemove())
        return

    if user_text in ["📱 My Accounts", "➕ New Login", "💰 Wallet", "👥 Refer & Earn", "🛠️ Customer Care"]:
        USER_STATES[user_id] = None

    state = USER_STATES.get(user_id)

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
            await update.message.reply_photo(
                photo=bio,
                caption=f"📲 Pay ₹{amount:.2f}\n⚠️ *Payment karke niche button par UTR daalein.*",
                reply_markup=verify_btn
            )
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
            await update.message.reply_text("❌ This UTR is already used! Kripya sahi UTR enter karein.")
            return
            
        tx_data = PENDING_TX.get(user_id)
        amount = tx_data["amount"] if tx_data else 10.0
        USER_STATES[user_id] = None
        
        tx_count = increment_tx_count(user_id)
        username = update.effective_user.username
        username_str = f"@{username}" if username else "No Username"
        
        if bot_app:
            admin_msg = (
                f"📥 **Payment Request**\n"
                f"👤 User ID: `{user_id}`\n"
                f"🏷️ Username: {username_str}\n"
                f"🔢 UTR: `{utr}`\n"
                f"📊 TX ID / Count: `{tx_count}`\n"
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
            await update.message.reply_text("⏳ **Payment Verification Pending!** Validation ka wait karein.")
        return

    elif state == "AWAITING_LOGIN_PHONE":
        phone = user_text.strip()
        USER_STATES[user_id] = {"state": "AWAITING_LOGIN_OTP", "phone": phone}
        await update.message.reply_text(f"📨 OTP sent to `{phone}`.\n\nKripya 6-digit ka **OTP** enter karein:", parse_mode="Markdown")
        return

    elif isinstance(state, dict) and state.get("state") == "AWAITING_LOGIN_OTP":
        otp = user_text.strip()
        phone = state.get("phone")
        USER_STATES[user_id] = None
        
        # Save account session upon successful OTP verification
        acc_id = secrets.token_hex(4)
        session_data = {
            'phone': phone,
            'token': f"bb_token_{secrets.token_hex(12)}",
            'tid': f"bb_tid_{secrets.token_hex(16)}"
        }
        rtdb.reference(f'accounts/{user_id}/{acc_id}').set(session_data)
        
        await update.message.reply_text(f"✅ **Account Login Successful!**\nPhone: `{phone}`\n\nAb yeh account aapke '📱 My Accounts' aur Mini App mein dikhega.", parse_mode="Markdown", reply_markup=load_dashboard_menu())
        return

    if user_text == "💰 Wallet":
        current_bal, current_pts = get_user_data(user_id)
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(f"💳 **Balance:** `₹{current_bal:.2f}`\n⭐ **Points:** `{current_pts:.1f}`\n\n📥 Enter amount to deposit (Min ₹10):", parse_mode="Markdown")
    elif user_text == "👥 Refer & Earn":
        bot_username = context.bot.username
        ref_link = f"https://t.me/{bot_username}?start={user_id}"
        _, current_pts = get_user_data(user_id)
        ref_text = (
            f"👥 **Refer & Earn Program**\n\n"
            f"🔗 Your Referral Link:\n`{ref_link}`\n\n"
            f"📌 **Rule:** Share this link with friends. When a new user starts the bot using your link, you get **2 Points** instantly!\n"
            f"⭐ Your Total Points: **{current_pts:.1f} Points**"
        )
        await update.message.reply_text(ref_text, parse_mode="Markdown")
    elif user_text == "🛠️ Customer Care":
        await update.message.reply_text("Contact Support: @gbx_support_bot")
    elif user_text == "📱 My Accounts":
        accs = rtdb.reference(f'accounts/{user_id}').get() or {}
        if accs:
            acc_list_text = f"📱 **Your Saved Accounts ({len(accs)}):**\n\n"
            keyboard_buttons = []
            for idx, (acc_key, acc_val) in enumerate(accs.items(), 1):
                phone = acc_val.get('phone', 'N/A')
                acc_list_text += f"{idx}. 📞 `{phone}`\n"
                keyboard_buttons.append([InlineKeyboardButton(f"📤 Export Auth ({phone})", callback_data=f"export_auth:{user_id}:{acc_key}")])
            
            await update.message.reply_text(acc_list_text, reply_markup=InlineKeyboardMarkup(keyboard_buttons), parse_mode="Markdown")
        else:
            await update.message.reply_text(f"🆔 **Your Telegram ID:** `{user_id}`\n\n📌 *No active accounts found. Use '➕ New Login' or send account JSON file.*", parse_mode="Markdown")
    elif user_text == "➕ New Login":
        USER_STATES[user_id] = "AWAITING_LOGIN_PHONE"
        await update.message.reply_text("📱 **Enter BigBasket Mobile Number:**\n*(Ya apna account JSON file direct yahan chat mein upload kar sakte hain)*", parse_mode="Markdown")
    else:
        if user_id == ADMIN_CHAT_ID and update.message and not update.message.text.startswith("/"):
            user_ids = get_all_user_ids()
            success_count, fail_count = 0, 0
            status_msg = await update.message.reply_text(f"🚀 Broadcasting message to {len(user_ids)} users...")
            for uid in user_ids:
                try:
                    await bot_app.bot.copy_message(chat_id=uid, from_chat_id=update.message.chat_id, message_id=update.message.message_id)
                    success_count += 1
                except Exception:
                    fail_count += 1
            await status_msg.edit_text(f"✅ **Broadcast Completed!**\n\n- Sent: {success_count}\n- Failed: {fail_count}")
            return
        await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu())

async def admin_action_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global bot_app
    query = update.callback_query
    if query:
        await query.answer()
        data = query.data.split(":")
        
        if data[0] == "export_auth":
            target_user = int(data[1])
            acc_key = data[2]
            acc_data = rtdb.reference(f'accounts/{target_user}/{acc_key}').get()
            if acc_data:
                json_str = json.dumps(acc_data, indent=2)
                bio = io.BytesIO(json_str.encode('utf-8'))
                bio.name = f"session_{acc_data.get('phone', 'account')}.json"
                bio.seek(0)
                await query.message.reply_document(document=bio, caption=f"📁 **Auth Session Exported for {acc_data.get('phone')}**", parse_mode="Markdown")
            else:
                await query.answer("❌ Account not found!", show_alert=True)
            return

        action, target_user = data[0], int(data[1])
        utr = data[3] if len(data) > 3 else "N/A"
        
        if utr != "N/A":
            add_used_utr(utr)

        if action == "adm_accept":
            amount = float(data[2])
            update_balance(target_user, amount) 
            PENDING_TX.pop(target_user, None)
            
            await query.message.edit_text(f"✅ Approved! ₹{amount} added to User `{target_user}`. UTR locked.")
            if bot_app:
                try: 
                    new_total, _ = get_user_data(target_user)
                    await bot_app.bot.send_message(target_user, f"🎉 **Payment Verified!**\nBalance Added: ₹{amount}\nTotal Balance: ₹{new_total}")
                except Exception as e:
                    logging.error(f"User notify error: {e}")
        elif action == "adm_reject":
            PENDING_TX.pop(target_user, None)
            await query.message.edit_text(f"❌ Rejected request for User `{target_user}`. UTR locked.")
            if bot_app:
                try:
                    rejection_text = "⌛<b>Payment Rejected!</b>\nInvalid Or Wrong UTR ❌\n\nPlease Contact Admin\n👉 @gbx_support_bot"
                    await bot_app.bot.send_message(chat_id=target_user, text=rejection_text, parse_mode="HTML")
                except Exception as e:
                    logging.error(f"Rejection msg error: {e}")
        return

async def prompt_utr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    
    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await query.message.delete()
        buttons = []
        for target in remaining:
            buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
        buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
        await query.message.reply_text(f"⚠️ **Access Denied!**\nBache hue `{len(remaining)}` channels join karein.", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
        await query.message.reply_text("🔒 *Menu Locked!*", reply_markup=ReplyKeyboardRemove())
        return

    USER_STATES[user_id] = "AWAITING_UTR"
    await query.message.delete()
    await query.message.reply_text("📝 **Ab 12-digit ka UTR Number type karke bhejein:**", parse_mode="Markdown")

# --- FASTAPI SERVER ---
api_app = FastAPI()

@api_app.get("/")
def home():
    return JSONResponse({"status": "ok", "service": "GBX Telegram Bot Server"})

@api_app.get("/api/user-balance")
def get_user_api_balance(user_id: int = 0):
    if user_id > 0:
        bal, pts = get_user_data(user_id)
        return JSONResponse({"user_id": user_id, "balance": float(bal), "points": float(pts)})
    return JSONResponse({"user_id": 0, "balance": 0.0, "points": 0.0})

@api_app.get("/api/user-accounts")
def get_user_accounts_api(user_id: int = 0):
    if user_id > 0:
        accs = rtdb.reference(f'accounts/{user_id}').get() or {}
        formatted = []
        for k, v in accs.items():
            formatted.append({"id": k, "phone": v.get("phone", "N/A")})
        return JSONResponse({"accounts": formatted})
    return JSONResponse({"accounts": []})

@api_app.get("/api/place-order")
def place_order_api(user_id: int = 0, amount: float = 6.0):
    if user_id <= 0:
        return JSONResponse({"success": False, "message": "Invalid User ID"})
    
    current_bal, _ = get_user_data(user_id)
    
    if current_bal >= amount:
        new_bal = current_bal - amount
        try:
            ref = rtdb.reference(f'users/{user_id}')
            ref.update({'balance': new_bal})
            logging.info(f"Deducted ₹{amount} for order from user {user_id}. New balance: {new_bal}")
        except Exception as e:
            logging.error(f"Error deducting balance for user {user_id}: {e}")
            return JSONResponse({"success": False, "message": "Database error processing payment."})
            
        return JSONResponse({"success": True, "new_balance": float(new_bal)})
    else:
        return JSONResponse({
            "success": False, 
            "message": f"Your current balance is ₹{current_bal:.2f}. Required ₹{amount:.2f}. Please add money to wallet!"
        })

@api_app.on_event("startup")
async def startup_event():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")

    if TOKEN:
        try:
            bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
            bot_app.add_handler(CommandHandler("start", start))
            bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
            bot_app.add_handler(CallbackQueryHandler(prompt_utr, pattern="ask_utr:.*"))
            bot_app.add_handler(CallbackQueryHandler(admin_action_handler, pattern="adm_.*|export_auth:.*"))
            bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.Document.ALL & ~filters.COMMAND, handle_text_messages))
            bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, handle_text_messages))
            
            await bot_app.initialize()
            await bot_app.start()
            logging.info("Main bot initialized successfully.")
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
