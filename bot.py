import os
import logging
import urllib.request
import urllib.parse
import json
import random
import re
import psycopg2
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- MASTER SUPABASE CLOUD DATABASE LAYER ---
DB_URI = "postgresql://postgres.zurfsqxesuoptiaumadh:Rounakjjj1234@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"

def init_db():
    try:
        conn = psycopg2.connect(DB_URI)
        conn.autocommit = True
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
        logging.info("Supabase database tables checked/created successfully.")
    except Exception as e:
        logging.error(f"Database initialization error: {e}")

def get_balance(user_id: int) -> float:
    try:
        conn = psycopg2.connect(DB_URI)
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM users WHERE user_id = %s", (user_id,))
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row[0] if row else 0.0
    except Exception as e:
        logging.error(f"Error getting balance: {e}")
        return 0.0

def update_balance(user_id: int, amount: float):
    try:
        conn = psycopg2.connect(DB_URI)
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO users (user_id, balance) VALUES(%s, %s)
            ON CONFLICT(user_id) DO UPDATE SET balance = users.balance + EXCLUDED.balance
        ''', (user_id, amount, amount))
        cursor.close()
        conn.close()
    except Exception as e:
        logging.error(f"Error updating balance: {e}")

def is_utr_used(utr: str) -> bool:
    try:
        conn = psycopg2.connect(DB_URI)
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM used_utrs WHERE utr = %s", (utr,))
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row is not None
    except Exception as e:
        logging.error(f"Error checking UTR: {e}")
        return False

def add_used_utr(utr: str):
    try:
        conn = psycopg2.connect(DB_URI)
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute("INSERT INTO used_utrs (utr) VALUES (%s) ON CONFLICT DO NOTHING", (utr,))
        cursor.close()
        conn.close()
    except Exception as e:
        logging.error(f"Error adding UTR: {e}")

# Initialize Database cloud structure
init_db()

# --- GLOBAL SYSTEM LAYERS CONFIG ---
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

# --- MASTER CONFIGURATION (CONNECTED BOTS) ---
ADMIN_CHAT_ID = 8254886110
CHECKER_BOT_TOKEN = "8962475784:AAHeXQ-AGXSiTLYlFwKJV-OUMEBR2tno9xA"

# In-Memory Volatile States (Safe to lose on restart)
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

async def verify_user_membership(user_id: int) -> bool:
    global bot_app
    if not bot_app: return False
    for target in REQUIRED_TARGETS:
        try:
            member = await bot_app.bot.get_chat_member(chat_id=target, user_id=user_id)
            if member.status in ['left', 'kicked']: return False
        except TelegramError: return False
    return True

async def show_force_join_menu(update: Update):
    buttons = []
    for target in REQUIRED_TARGETS:
        buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
    buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
    await update.message.reply_text("⚠️ **Access Denied!**\nJoin channels to use bot.", reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await verify_user_membership(update.effective_user.id):
        await show_force_join_menu(update)
        return
    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if await verify_user_membership(query.from_user.id):
        await query.message.delete()
        await query.message.reply_text("✅ **Access Granted! Welcome.**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        await query.answer(text="❌ Saare channels aur GC join nahi kiye!", show_alert=True)

async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global checker_app
    user_id = update.effective_user.id
    user_text = update.message.text
    
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
            
            verify_btn = InlineKeyboardMarkup([[InlineKeyboardButton(text="🔄 Verify Payment (Enter UTR)", callback_data=f"ask_utr:{amount}")]])
            await update.message.reply_photo(
                photo=f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=upi://pay?pa={YOUR_UPI_ID}&pn={MERCHANT_NAME}&am={amount}&tr={tx_ref}",
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
                    InlineKeyboardButton("❌ Reject", callback_data=f"adm_reject:{user_id}")
                ]]),
                parse_mode="Markdown"
            )
            await update.message.reply_text("⏳ **Payment Verification Pending!** Checker bot validation ka wait karein.")
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

# --- ACTION LOGIC FOR CHECKER BOT BUTTONS ---
async def checker_admin_action_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global bot_app
    query = update.callback_query
    await query.answer()
    
    data = query.data.split(":")
    action, target_user = data[0], int(data[1])
    
    if action == "adm_accept":
        amount, utr = float(data[2]), data[3]
        if is_utr_used(utr):
            await query.message.edit_text("❌ Already processed.")
            return
            
        add_used_utr(utr)  
        update_balance(target_user, amount) 
        PENDING_TX.pop(target_user, None)
        
        new_total = get_balance(target_user)
        await query.message.edit_text(f"✅ Approved! ₹{amount} added to User `{target_user}`.")
        if bot_app:
            try:
                await bot_app.bot.send_message(target_user, f"🎉 **Payment Verified!**\nBalance Added: ₹{amount}\nTotal Balance: ₹{new_total}")
            except: pass
    else:
        PENDING_TX.pop(target_user, None)
        await query.message.edit_text(f"❌ Rejected request for User `{target_user}`.")
        if bot_app:
            try:
                rejection_text = (
                    "⌛<b>Payment Rejected!</b>\n"
                    "Invalid Or Wrong UTR ❌\n\n"
                    "Please Contact Admin\n"
                    "👉 @gbx_support_bot"
                )
                await bot_app.bot.send_message(
                    chat_id=target_user, 
                    text=rejection_text,
                    parse_mode="HTML"
                )
            except: pass

async def prompt_utr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    USER_STATES[query.from_user.id] = "AWAITING_UTR"
    await query.message.delete()
    await query.message.reply_text("📝 **Ab 12-digit ka UTR Number type karke bhejein:**", parse_mode="Markdown")

# --- FASTAPI SERVER MODULE ---
api_app = FastAPI()

@api_app.get("/")
def home(): return FileResponse("index.html")

@api_app.on_event("startup")
async def init_webhook_mode():
    global bot_app, checker_app
    TOKEN = os.getenv("BOT_TOKEN")
    URL = os.getenv("RENDER_EXTERNAL_URL")
    if not TOKEN or not URL: return

    bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(CallbackQueryHandler(prompt_utr, pattern="ask_utr:.*"))
    bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, handle_text_messages))
    
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.bot.set_webhook(url=f"{URL}/webhook")

    checker_app = Application.builder().token(CHECKER_BOT_TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
    checker_app.add_handler(CallbackQueryHandler(checker_admin_action_handler, pattern="adm_.*"))
    
    await checker_app.initialize()
    await checker_app.start()
    await checker_app.bot.set_webhook(url=f"{URL}/webhook/checker")

@api_app.post("/webhook")
async def receive_telegram_update(request: Request):
    global bot_app
    if bot_app:
        data = await request.json()
        await bot_app.process_update(Update.de_json(data, bot_app.bot))
    return Response(status_code=200)

@api_app.post("/webhook/checker")
async def receive_checker_update(request: Request):
    global checker_app
    if checker_app:
        data = await request.json()
        await checker_app.process_update(Update.de_json(data, checker_app.bot))
    return Response(status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(api_app, host="0.0.0.0", port=port)
        
