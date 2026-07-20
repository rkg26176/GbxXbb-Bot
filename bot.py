import os
import logging
import random
import re
import psycopg2
import time
import urllib.parse
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo, ReplyKeyboardRemove
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- MASTER SUPABASE NATIVE CONNECTION LAYER ---
DB_URI = "postgresql://postgres.zurfsqxesuoptiaumadh:Rounakjjj1234@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"

def get_db_connection(retries=3):
    for i in range(retries):
        try:
            conn = psycopg2.connect(DB_URI, connect_timeout=15)
            conn.autocommit = True
            return conn
        except Exception as e:
            logging.error(f"Database connection attempt {i+1} failed: {e}")
            if i < retries - 1:
                time.sleep(2)
    raise Exception("Could not connect to Supabase after retries.")

def init_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                balance REAL DEFAULT 0.0
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS used_utrs (
                utr TEXT PRIMARY KEY
            )
        ''')
        cursor.close()
        conn.close()
        logging.info("Supabase permanent tables verified successfully.")
    except Exception as e:
        logging.error(f"Database init error: {e}")

def get_balance(user_id: int) -> float:
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM users WHERE user_id = %s", (user_id,))
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        if row is not None:
            return float(row[0])
        return 0.0
    except Exception as e:
        logging.error(f"Error getting balance for user {user_id}: {e}")
        return 0.0

def update_balance(user_id: int, amount: float):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM users WHERE user_id = %s", (user_id,))
        row = cursor.fetchone()
        
        if row is not None:
            new_bal = float(row[0]) + amount
            cursor.execute("UPDATE users SET balance = %s WHERE user_id = %s", (new_bal, user_id))
        else:
            cursor.execute("INSERT INTO users (user_id, balance) VALUES (%s, %s)", (user_id, amount))
            
        cursor.close()
        conn.close()
        logging.info(f"Balance verified and committed for {user_id}: +{amount}")
    except Exception as e:
        logging.error(f"Critical error updating balance for user {user_id}: {e}")

def get_all_user_ids():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT user_id FROM users")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [row[0] for row in rows]
    except Exception as e:
        logging.error(f"Error fetching all user IDs: {e}")
        return []

def is_utr_used(utr: str) -> bool:
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM used_utrs WHERE utr = %s", (str(utr).strip(),))
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row is not None
    except Exception as e:
        logging.error(f"Error checking UTR {utr}: {e}")
        return False

def add_used_utr(utr: str):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT INTO used_utrs (utr) VALUES (%s) ON CONFLICT DO NOTHING", (str(utr).strip(),))
        cursor.close()
        conn.close()
        logging.info(f"UTR {utr} registered permanently.")
    except Exception as e:
        logging.error(f"Error storing UTR {utr}: {e}")

init_db()

# --- SYSTEM CONFIGS ---
REQUIRED_TARGETS = [-1003332858806, -1003630519339, -1003197501531, -1003862251237]
TARGET_LINKS = {
    -1003332858806: "https://t.me/+6ByfGDRBKgsxMjZl",   
    -1003630519339: "https://t.me/+OWrCoeF-JutmNjg1",   
    -1003197501531: "https://t.me/+f2mWfDs6EUIxYTBl",   
    -1003862251237: "https://t.me/+O_-kEF2f5f1kMjdl"            
}
TARGET_LABELS = {
    -1003332858806: "📢 Join GBX LOOT", 
    -1003630519339: "📢 Join GBX EARN",
    -1003197501531: "📢 Join GBX Zone", 
    -1003862251237: "💬 Join Group Chat (GC)"
}

ADMIN_CHAT_ID = 8053042225
CHECKER_BOT_TOKEN = "8962475784:AAHeXQ-AGXSiTLYlFwKJV-OUMEBR2tno9xA"

USER_STATES = {}
PENDING_TX = {}
YOUR_UPI_ID = "BHARATPE.8R0I1G1N4X31943@fbpe" 
MERCHANT_NAME = "GBX"
bot_app = None
checker_app = None

def load_dashboard_menu():
    MINI_APP_URL = os.getenv("RENDER_EXTERNAL_URL", "https://gbxxbb-bot.onrender.com")
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("➕ New Login")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("🛠️ Customer Care")],
        [KeyboardButton("🛒 Live BigBasket Store", web_app=WebAppInfo(url=MINI_APP_URL))]
    ], resize_keyboard=True)

async def get_remaining_channels(user_id: int):
    global bot_app
    remaining = []
    if not bot_app: return REQUIRED_TARGETS
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
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT INTO users (user_id, balance) VALUES (%s, 0.0) ON CONFLICT (user_id) DO NOTHING", (user_id,))
        cursor.close()
        conn.close()
    except: pass

    remaining = await get_remaining_channels(user_id)
    if len(remaining) > 0:
        await show_force_join_menu(update, remaining)
        return
    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = query.from_user.id
    await query.answer()
    
    remaining = await get_remaining_channels(user_id)
    total_left = len(remaining)
    
    if total_left == 0:
        try: await query.message.delete()
        except: pass
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
    global checker_app
    user_id = update.effective_user.id
    user_text = update.message.text
    
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

    if user_text in ["📱 My Accounts", "➕ New Login", "💰 Wallet", "🛠️ Customer Care"]:
        USER_STATES[user_id] = None

    if USER_STATES.get(user_id) == "AWAITING_AMOUNT":
        try:
            amount = float(user_text)
            if amount < 10.0:
                await update.message.reply_text("❌ Min ₹10 required.")
                return
            USER_STATES[user_id] = None
            tx_ref = f"GBX{user_id}X{random.randint(1000, 9999)}"
            PENDING_TX[user_id] = {"amount": amount, "tx_ref": tx_ref}
            
            raw_upi_string = f"upi://pay?pa={YOUR_UPI_ID}&pn={MERCHANT_NAME}&am={amount:.2f}&cu=INR&tr={tx_ref}"
            encoded_upi_string = urllib.parse.quote(raw_upi_string)
            qr_code_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={encoded_upi_string}"
            
            verify_btn = InlineKeyboardMarkup([[InlineKeyboardButton(text="🔄 Verify Payment (Enter UTR)", callback_data=f"ask_utr:{amount}")]])
            await update.message.reply_photo(
                photo=qr_code_url,
                caption=f"📲 Pay ₹{amount:.2f}\n⚠️ *Payment karke niche button par UTR daalein.*",
                reply_markup=verify_btn
            )
            return
        except ValueError:
            await update.message.reply_text("❌ Numeric amount daalein.")
            return

    elif USER_STATES.get(user_id) == "AWAITING_UTR":
        if not re.match(r"^\d{12}$", user_text.strip()):
            await update.message.reply_text("❌ 12-digit UTR daalein.")
            return
            
        utr = user_text.strip()
        if is_utr_used(utr):
            await update.message.reply_text("❌ This UTR is already used! Kripya sahi UTR enter karein.")
            return
            
        tx_data = PENDING_TX.get(user_id)
        if tx_data and checker_app:
            amount = tx_data["amount"]
            USER_STATES[user_id] = None
            
            await checker_app.bot.send_message(
                chat_id=ADMIN_CHAT_ID,
                text=f"📥 **New Deposit Alert!**\n👤 User ID: `{user_id}`\n💰 Amount: ₹{amount}\n🔢 UTR: `{utr}`",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("✅ Accept", callback_data=f"adm_accept:{user_id}:{amount}:{utr}"),
                    InlineKeyboardButton("❌ Reject", callback_data=f"adm_reject:{user_id}:{utr}")
                ]]),
                parse_mode="Markdown"
            )
            await update.message.reply_text("⏳ **Payment Verification Pending!** Validation ka wait karein.")
        return

    if user_text == "💰 Wallet":
        current_bal = get_balance(user_id)
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(f"💳 **Balance:** `₹{current_bal:.2f}`\n📥 Enter amount (Min ₹10):", parse_mode="Markdown")
    elif user_text == "🛠️ Customer Care":
        await update.message.reply_text("Contact: @gbx_support_bot")
    elif user_text == "📱 My Accounts":
        current_bal = get_balance(user_id)
        await update.message.reply_text(f"🆔 ID: `{user_id}`\n💰 Balance: `₹{current_bal:.2f}`", parse_mode="Markdown")
    elif user_text == "➕ New Login":
        await update.message.reply_text("🚧 Terminal Interface Active.")
    else:
        await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu())

# --- ALL-MEDIA BROADCAST HANDLER ---
async def checker_admin_action_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global bot_app
    query = update.callback_query
    
    if query:
        await query.answer()
        data = query.data.split(":")
        action, target_user = data[0], int(data[1])
        utr = data[3] if len(data) > 3 else "N/A"
        
        if action == "adm_accept":
            amount = float(data[2])
            if is_utr_used(utr):
                await query.message.edit_text(f"❌ Already processed for User `{target_user}`.")
                return
                
            add_used_utr(utr)  
            update_balance(target_user, amount) 
            PENDING_TX.pop(target_user, None)
            
            await query.message.edit_text(f"✅ Approved! ₹{amount} added to User `{target_user}`.")
            if bot_app:
                try: 
                    new_total = get_balance(target_user)
                    await bot_app.bot.send_message(target_user, f"🎉 **Payment Verified!**\nBalance Added: ₹{amount}\nTotal Balance: ₹{new_total}")
                except: pass
        else:
            PENDING_TX.pop(target_user, None)
            await query.message.edit_text(f"❌ Rejected request for User `{target_user}`.")
            if bot_app:
                try:
                    rejection_text = "⌛<b>Payment Rejected!</b>\nInvalid Or Wrong UTR ❌\n\nPlease Contact Admin\n👉 @gbx_support_bot"
                    await bot_app.bot.send_message(chat_id=target_user, text=rejection_text, parse_mode="HTML")
                except: pass
        return

    message = update.message
    if message and message.from_user.id == ADMIN_CHAT_ID:
        if message.text and message.text.startswith("/"):
            return

        user_ids = get_all_user_ids()
        success_count = 0
        fail_count = 0

        status_msg = await message.reply_text(f"🚀 Broadcasting message to {len(user_ids)} users...")

        if bot_app:
            for uid in user_ids:
                try:
                    await bot_app.bot.copy_message(
                        chat_id=uid,
                        from_chat_id=message.chat_id,
                        message_id=message.message_id
                    )
                    success_count += 1
                except Exception as e:
                    fail_count += 1
                    logging.error(f"Broadcast failed for {uid}: {e}")

            await status_msg.edit_text(f"✅ **Broadcast Completed!**\n\n- Sent: {success_count}\n- Failed: {fail_count}")

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

# --- FASTAPI BACKEND ---
api_app = FastAPI()

@api_app.get("/api/user-balance/{user_id}")
def get_user_api_balance(user_id: int):
    bal = get_balance(user_id)
    return JSONResponse({"user_id": user_id, "balance": bal})

@api_app.get("/", response_class=HTMLResponse)
def home():
    # Stable Clean Mini App UI with Real Wallet Balance & Accounts Section
    html_content = """
    <!DOCTYPE html>
    <html lang="hi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>GBX Store Dashboard</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                padding: 15px;
                background-color: #0f172a;
                color: #f8fafc;
            }
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #334155;
                padding-bottom: 12px;
            }
            .wallet-card {
                background: linear-gradient(135deg, #1e293b, #334155);
                border-radius: 12px;
                padding: 16px;
                margin-top: 15px;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }
            .wallet-title {
                font-size: 14px;
                color: #94a3b8;
            }
            .wallet-balance {
                font-size: 26px;
                font-weight: bold;
                color: #38bdf8;
                margin-top: 5px;
            }
            .section-title {
                font-size: 16px;
                font-weight: bold;
                margin-top: 25px;
                margin-bottom: 10px;
                color: #cbd5e1;
            }
            .accounts-box {
                background: #1e293b;
                border-radius: 10px;
                padding: 12px;
                border: 1px solid #334155;
            }
            .account-item {
                display: flex;
                justify-content: space-between;
                padding: 8px 0;
                border-bottom: 1px solid #334155;
                font-size: 14px;
            }
            .account-item:last-child {
                border-bottom: none;
            }
        </style>
    </head>
    <body>

        <div class="header">
            <h3>⚡ GBX Terminal</h3>
            <span id="user-name" style="font-size: 14px; color: #38bdf8;">Loading...</span>
        </div>

        <!-- Real Wallet Balance Card -->
        <div class="wallet-card">
            <div class="wallet-title">💳 Wallet Balance</div>
            <div class="wallet-balance" id="wallet-balance">₹0.00</div>
        </div>

        <!-- My Accounts Section -->
        <div class="section-title">📱 My Accounts & Logins</div>
        <div class="accounts-box" id="accounts-container">
            <div class="account-item">
                <span>User ID:</span>
                <span id="display-user-id" style="color: #cbd5e1;">--</span>
            </div>
            <div class="account-item">
                <span>Status:</span>
                <span style="color: #4ade80;">Active (Connected)</span>
            </div>
        </div>

        <script>
            const tg = window.Telegram.WebApp;
            tg.expand();

            let userId = 0;
            if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
                const user = tg.initDataUnsafe.user;
                userId = user.id;
                document.getElementById('user-name').i
