import os
import logging
import asyncio
import uvicorn
from fastapi import FastAPI
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

# Logging configuration for Render dashboard view
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GLOBAL SETTINGS ---
REQUIRED_TARGETS = [
    -1003332858806,  # GBX LOOT ID
    -1003630519339,  # GBX EARN ID
    -1003197501531,  # GBX Zone ID
    -1003862251237   # Group Chat (GC) ID
]

TARGET_LINKS = {
    -1003332858806: "https://t.me/gbx_loot_channel_username",   
    -1003630519339: "https://t.me/gbx_earn_channel_username",   
    -1003197501531: "https://t.me/gbx_zone_channel_username",   
    -1003862251237: "https://t.me/+O_-kEF2f5f1kMjdl"            
}

TARGET_LABELS = {
    -1003332858806: "📢 Join GBX LOOT",
    -1003630519339: "📢 Join GBX EARN",
    -1003197501531: "📢 Join GBX Zone",
    -1003862251237: "💬 Join Group Chat (GC)"
}

bot_app = None

async def verify_user_membership(user_id: int) -> bool:
    global bot_app
    if not bot_app:
        return False
    for target in REQUIRED_TARGETS:
        try:
            member = await bot_app.bot.get_chat_member(chat_id=target, user_id=user_id)
            if member.status in ['left', 'kicked']:
                return False
        except TelegramError as e:
            logging.error(f"Error checking verification for target {target}: {e}")
            return False
    return True

async def show_force_join_menu(update: Update):
    buttons = []
    for target in REQUIRED_TARGETS:
        url = TARGET_LINKS.get(target, "https://t.me/")
        label = TARGET_LABELS.get(target, "Join Community")
        buttons.append([InlineKeyboardButton(text=label, url=url)])
        
    buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
    reply_markup = InlineKeyboardMarkup(buttons)
    
    alert_text = (
        "⚠️ **Access Denied!**\n\n"
        "GbxXbb Bot ke features use karne ke liye aapko hamare **3 Channels** aur **Group Chat (GC)** ko join karna zaroori hai.\n\n"
        "Links join karke niche diye gaye button se status verify karein."
    )
    
    if update.message:
        await update.message.reply_text(alert_text, reply_markup=reply_markup, parse_mode="Markdown")
    elif update.callback_query:
        await update.callback_query.message.reply_text(alert_text, reply_markup=reply_markup, parse_mode="Markdown")

def load_dashboard_menu():
    keyboard = [
        [KeyboardButton("📱 My Accounts"), KeyboardButton("🏠 Home")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("➕ New Login")]
    ]
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    is_authorized = await verify_user_membership(user_id)
    if not is_authorized:
        await show_force_join_menu(update)
        return
        
    await update.message.reply_text(
        "✨ **GbxXbb Dashboard Active!**\n\nVerification complete ho chuka hai. Niche diye gaye menu buttons se interface navigate karein:",
        reply_markup=load_dashboard_menu(),
        parse_mode="Markdown"
    )

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id
    
    is_valid = await verify_user_membership(user_id)
    if is_valid:
        await query.message.delete()
        await query.message.reply_text(
            "✅ Verification successful! Welcome to the main dashboard menu:",
            reply_markup=load_dashboard_menu()
        )
    else:
        await query.answer(text="❌ Aapne abhi tak saare channels ya GC join nahi kiya hai!", show_alert=True)

async def process_menu_clicks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not await verify_user_membership(user_id):
        await show_force_join_menu(update)
        return

    user_text = update.message.text
    if user_text == "📱 My Accounts":
        await update.message.reply_text("📂 Aapke authenticated account profiles ki list yahan display hogi...")
    elif user_text == "💰 Wallet":
        await update.message.reply_text("💵 Wallet Dashboard:\n\n• Current Active Balance: ₹0.00\n\nAdd money karne ke liye generic system ready ho raha hai.")
    elif user_text == "➕ New Login":
        await update.message.reply_text("🔑 Naya account register karne ke liye generic Phone Number (+91) format me input karein:")
    elif user_text == "🏠 Home":
        await update.message.reply_text("Aap main dashboard home page par hi hain.")

# --- FASTAPI APP SYSTEM ---
api_app = FastAPI()

@api_app.get("/")
def home():
    return {"status": "GbxXbb API Service Online"}

# Clean asynchronous wrapper launcher block
async def main_async_pipeline():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")
    if not TOKEN:
        logging.critical("BOT_TOKEN environment key is missing!")
        return

    # Native integration configuration sequence v20+
    bot_app = Application.builder().token(TOKEN).build()
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, process_menu_clicks))

    # Clean non-blocking custom initialization loop logic
    await bot_app.initialize()
    await bot_app.start()
    
    # Starting standard server listener framework
    port = int(os.getenv("PORT", 8000))
    config = uvicorn.Config(api_app, host="0.0.0.0", port=port, log_level="warning")
    server = uvicorn.Server(config)
    
    # Run loop updates alongside target bot server frameworks seamlessly
    await asyncio.gather(
        server.serve(),
        bot_app.updater.start_polling(drop_pending_updates=True)
    )

if __name__ == "__main__":
    # Standard native loop runner trigger execution
    asyncio.run(main_async_pipeline())
    
