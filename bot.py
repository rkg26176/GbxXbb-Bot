import os
import logging
import urllib.request
import urllib.parse
import json
import random
import hmac
import hashlib
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

# Real integration check: Razorpay framework instance check
try:
    import razorpay
except ImportError:
    # Fallback to prevent startup crashes if dependency injection is lazy
    razorpay = None

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GLOBAL SYSTEM LAYERS CONFIG ---
REQUIRED_TARGETS = [
    -1003332858806, -1003630519339, -1003197501531, -1003862251237
]
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

# Production Ledger Database Map
USER_BALANCES = {}
USER_STATES = {}

# RAZORPAY API INTEGRATION ENDPOINTS
# (Render Environment Variables me RAZORPAY_KEY_ID aur RAZORPAY_KEY_SECRET add kar lena)
RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID", "rzp_test_placeholder_id")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "placeholder_secret")
RAZORPAY_WEBHOOK_SECRET = os.getenv("RAZORPAY_WEBHOOK_SECRET", "gbx_secure_token_hook")

# Initialize Razorpay Client Instance Hook Safely
rzp_client = None
if razorpay and RAZORPAY_KEY_ID != "rzp_test_placeholder_id":
    rzp_client = razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))

bot_app = None

# STRICT 5-BUTTON MASTER MATRIX GRID
def load_dashboard_menu():
    MINI_APP_URL = os.getenv("RENDER_EXTERNAL_URL", "https://gbxxbb-bot.onrender.com")
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("➕ New Login")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("🛠️ Customer Care")],
        [KeyboardButton("🛒 Live BigBasket Store", web_app=WebAppInfo(url=MINI_APP_URL))]
    ], resize_keyboard=True, one_time_keyboard=False)

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
    
    alert_text = "⚠️ **Access Denied!**\n\nBot features use karne ke liye channels aur GC join karein."
    if update.message: 
        await update.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
    elif update.callback_query: 
        await update.callback_query.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

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
        await query.message.reply_text("✅ **Access Granted! Welcome to GBX Dashboard.**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        await query.answer(text="❌ Saare channels aur GC join nahi kiye!", show_alert=True)

# TEXT INPUT PARSER ROUTER GATES
async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_text = update.message.text
    
    MENU_COMMANDS = ["📱 My Accounts", "➕ New Login", "💰 Wallet", "🛠️ Customer Care"]
    if user_text in MENU_COMMANDS:
        USER_STATES[user_id] = None # Flush input context parameters instantly

    # Automated Amount Handling Path Layer
    if USER_STATES.get(user_id) == "AWAITING_AMOUNT":
        try:
            amount = float(user_text)
            if amount < 10.0:
                await update.message.reply_text("❌ **Payment Rejected!**\n\nMinimum deposit amount **₹10** hai. Kripya enter karein:")
                return
            
            USER_STATES[user_id] = None # Reset allocation state
            
            # RAZORPAY REAL DYNAMIC INVOICE/LINK CREATION ENGINE HOOK
            receipt_id = f"rcpt_{user_id}_{random.randint(100, 999)}"
            
            # If razorpay client is active, call production API nodes, else simulate live sandbox link routing
            if rzp_client:
                try:
                    # Razorpay dynamic payment link API generation specs mapping user transaction parameters
                    pay_link_data = rzp_client.payment_link.create({
                        "amount": int(amount * 100),  # Razorpay counts in paisa
                        "currency": "INR",
                        "accept_partial": False,
                        "reference_id": receipt_id,
                        "description": f"Wallet Deposit for Telegram User ID {user_id}",
                        "customer": {
                            "name": f"User {user_id}"
                        },
                        "notify": {"sms": False, "email": False},
                        "reminder_enable": False,
                        "notes": {
                            "telegram_user_id": str(user_id)
                        },
                        "callback_url": f"{os.getenv('RENDER_EXTERNAL_URL')}/",
                        "callback_method": "get"
                    })
                    live_payment_url = pay_link_data.get("short_url")
                except Exception as rzp_err:
                    logging.error(f"Razorpay link creation critical failure node: {rzp_err}")
                    live_payment_url = f"https://rzp.io/i/mock_sandbox_link?amt={amount}&ref={receipt_id}"
            else:
                # Sandbox dynamic tracking URL mapping layout
                live_payment_url = f"https://rzp.io/i/mock_sandbox_link?amt={amount}&ref={receipt_id}"

            pay_gateway_button = InlineKeyboardMarkup([
                [InlineKeyboardButton(text="💳 Pay Now via UPI / Card", url=live_payment_url)]
            ])
            
            await update.message.reply_text(
                f"💳 **Secure Payment Gateway Active**\n\n💵 **Amount to Add:** `₹{amount:.2f}`\n🆔 **Receipt Ref:** `{receipt_id}`\n\n⚠️ *Niche diye gaye button par click karke apna payment complete karein. Razorpay payment verify hote hi aapka balance automatic update ho jayega (No UTR Required).*",
                reply_markup=pay_gateway_button,
                parse_mode="Markdown"
            )
            return
            
        except ValueError:
            await update.message.reply_text("❌ Invalid amount format. Numeric parameters input karein:")
            return

    # Basic Menu Redirections
    if user_text == "🛠️ Customer Care":
        support_keyboard = InlineKeyboardMarkup([[InlineKeyboardButton(text="💬 Open Support Bot", url="https://t.me/gbx_support_bot")]])
        await update.message.reply_text("🙋‍♂️ **GBX Official Customer Support**", reply_markup=support_keyboard, parse_mode="Markdown")
        return
    elif user_text == "💰 Wallet":
        current_bal = USER_BALANCES.get(user_id, 0.0)
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(f"💳 **Your Wallet Balance:** `₹{current_bal:.2f}`\n\n📥 **Enter deposit amount (Min ₹10):**", parse_mode="Markdown")
        return
    elif user_text == "📱 My Accounts":
        current_bal = USER_BALANCES.get(user_id, 0.0)
        await update.message.reply_text(f"📱 **My Accounts Profile**\n\n🆔 User ID: `{user_id}`\n💰 Cash Ledger: `₹{current_bal:.2f}`", parse_mode="Markdown")
        return
    elif user_text == "➕ New Login":
        await update.message.reply_text("🚧 Login system terminal interface configuration active.", parse_mode="Markdown")
        return

    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def web_app_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_payload_wire = update.effective_message.web_app_data.data
    try:
        segmented_nodes = raw_payload_wire.split("^")
        extracted_tx_code = segmented_nodes[0].split(":")[1]
        extracted_final_bill = segmented_nodes[1].split(":")[1]
        extracted_location = segmented_nodes[2].split(":")[1]
        compiled_receipt = f"🎉 **Order Placed Successfully!**\n🆔 ID: `{extracted_tx_code}`\n💵 Bill: **{extracted_final_bill}**\n📍 Dest: `{extracted_location}`"
        await update.message.reply_text(compiled_receipt, parse_mode="Markdown")
    except Exception:
        await update.message.reply_text(f"🎉 **Order Placed Successfully!**\n📦 Pay: {raw_payload_wire}")

# --- FASTAPI SERVER MODULE WITH AUTOMATED WEBHOOK ROUTER ---
api_app = FastAPI()

@api_app.get("/")
def home(): 
    return FileResponse("index.html")

# 🚨 REAL-TIME AUTOMATED RAZORPAY GATEWAY INTERCEPTOR WEBHOOK
@api_app.post("/webhook/razorpay")
async def razorpay_automated_webhook_handler(request: Request):
    global bot_app
    try:
        raw_body_payload = await request.body()
        received_signature = request.headers.get("X-Razorpay-Signature", "")
        
        # Verify webhook secure parameters using native server auth tokens
        if rzp_client:
            try:
                rzp_client.utility.verify_webhook_signature(
                    raw_body_payload.decode('utf-8'),
                    received_signature,
                    RAZORPAY_WEBHOOK_SECRET
                )
            except Exception as sig_err:
                logging.error(f"Signature mismatch context security alert: {sig_err}")
                return Response(status_code=400)
                
        payload_data = json.loads(raw_body_payload.decode('utf-8'))
        event_type = payload_data.get("event")
        
        # Intercept success payloads metrics
        if event_type in ["payment.captured", "payment_link.paid"]:
            payment_entity = payload_data["payload"]["payment"]["entity"]
            
            # Extract linked data contexts mapped inside payment creation phase notes metadata fields
            notes_node = payment_entity.get("notes", {})
            target_telegram_user = notes_node.get("telegram_user_id")
            
            if not target_telegram_user:
                # Secondary fallback search logic matching order references fields mapping layout structures
                link_entity = payload_data["payload"].get("payment_link", {}).get("entity", {})
                notes_node = link_entity.get("notes", {})
                target_telegram_user = notes_node.get("telegram_user_id")

            if target_telegram_user:
                user_id_node = int(target_telegram_user)
                amount_credited = float(payment_entity.get("amount", 0)) / 100.0 # Convert paisa back to INR
                
                # Execute Automated Balance Allocation Engine Update Matrix
                USER_BALANCES[user_id_node] = USER_BALANCES.get(user_id_node, 0.0) + amount_credited
                
                # Instantly notify user through active pooling webhook bot clients threads
                if bot_app:
                    success_txt = f"🎉 **Automated Deposit Successful!**\n"
                    success_txt += "────────────────────────\n"
                    success_txt += f"💰 **Razorpay Funds Added:** +₹{amount_credited:.2f}\n"
                    success_txt += f"💳 **New Account Balance:** **₹{USER_BALANCES[user_id_node]:.2f}**\n"
                    success_txt += "────────────────────────\n"
                    success_txt += "✨ *Aapka wallet instant top-up ho gaya hai. Ab aap store use kar sakte hain!*"
                    
                    try:
                        await bot_app.bot.send_message(chat_id=user_id_node, text=success_txt, reply_markup=load_dashboard_menu(), parse_mode="Markdown")
                    except Exception as msg_err:
                        logging.error(f"Notification route intercept failed: {msg_err}")
                        
        return Response(status_code=200)
    except Exception as general_hook_err:
        logging.error(f"General webhook router parser malfunction node: {general_hook_err}")
        return Response(status_code=200) # Always return 200 to prevent Razorpay from blocking endpoint

@api_app.get("/api/search")
def proxy_search(query: str = "milk", page: int = 1):
    api_key = os.getenv("PARSE_BOT_API_KEY")
    if not api_key: return {"products": []}
    encoded_query = urllib.parse.quote(query.lower().strip())
    url = f"https://api.parse.bot/scraper/1d9ca2c5-176c-4bc0-9cf3-db9056850958/search_products?page={page}&query={encoded_query}"
    req = urllib.request.Request(url)
    req.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=8.0) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
            extracted_items = []
            if isinstance(raw_data, list): extracted_items = raw_data
            elif isinstance(raw_data, dict):
                for key in ["results", "products", "data", "items"]:
                    if isinstance(raw_data.get(key), list) and len(raw_data.get(key)) > 0:
                        extracted_items = raw_data[key]
                        break
            formatted_out = []
            for node in extracted_items[:15]:
                title = node.get("title") or node.get("name") or "BigBasket Item"
                price = node.get("price") or node.get("sale_price") or 45
                image = node.get("image") or node.get("image_url") or ""
                formatted_out.append({"title": title, "price": int(price), "image": image})
            return {"products": formatted_out}
    except Exception:
        return {"products": []}

@api_app.on_event("startup")
async def init_webhook_mode():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")
    URL = os.getenv("RENDER_EXTERNAL_URL")
    if not TOKEN or not URL: return

    bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
    
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data_handler))
    bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, handle_text_messages))
    
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.bot.set_webhook(url=f"{URL}/webhook")

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
            
