import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: [true, "Task title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [5000, "Description cannot exceed 5000 characters"],
    },

    dueDate: {
      type: Date,
      default: null,
    },

    // New date/time contract fields. Legacy documents may not contain these;
    // response serialization infers a safe value for them.
    dueDateType: {
      type: String,
      enum: ["none", "date", "dateTime"],
      default: undefined,
    },

    dueDateDate: {
      type: String,
      default: null,
    },

    timeZoneId: {
      type: String,
      default: null,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    category: {
      type: String,
      required: [true, "Task category is required"],
      trim: true,
      maxlength: [100, "Category cannot exceed 100 characters"],
    },

    isCompleted: {
      type: Boolean,
      default: false,
    },

    isUrgent: {
      type: Boolean,
      default: false,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    reminderMinutesBefore: {
      type: Number,
      default: null,
      validate: {
        validator(value) {
          return (
            value == null ||
            [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080].includes(value)
          );
        },
        message: "Thời gian nhắc không hợp lệ.",
      },
    },

    // Calendar-month reminder is intentionally separate from minutes: a month
    // cannot be represented as a fixed duration without losing month-end rules.
    reminderMonthsBefore: {
      type: Number,
      default: null,
      min: 1,
      max: 1,
      validate: {
        validator(value) {
          return value == null || value === 1;
        },
        message: "Số tháng nhắc trước không hợp lệ.",
      },
    },

    attachments: {
      type: [
        {
          _id: false,
          name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 255,
          },
          url: {
            type: String,
            required: true,
            trim: true,
            maxlength: 2048,
          },
          publicId: {
            type: String,
            trim: true,
            maxlength: 512,
          },
          mimeType: {
            type: String,
            required: true,
            enum: ["image/jpeg", "image/png", "image/webp", "image/heic"],
          },
          sizeBytes: {
            type: Number,
            min: 0,
            default: null,
          },
        },
      ],
      default: [],
      validate: {
        validator(value) {
          return value.length <= 5;
        },
        message: "Mỗi công việc chỉ được đính kèm tối đa 5 ảnh.",
      },
    },

    recurrenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    occurrenceIndex: {
      type: Number,
      default: null,
      min: 1,
    },

    recurrenceAdvancedAt: {
      type: Date,
      default: null,
    },

    recurrenceStoppedAt: {
      type: Date,
      default: null,
    },

    repeat: {
      enabled: {
        type: Boolean,
        default: false,
      },
      frequency: {
        type: String,
        enum: ["none", "daily", "weekly", "monthly"],
        default: "none",
      },
      interval: {
        type: Number,
        default: 1,
        min: 1,
        max: 365,
      },
      weekdays: {
        type: [Number],
        default: [],
      },
      anchorDate: {
        type: String,
        default: null,
      },
      anchorDay: {
        type: Number,
        default: null,
        min: 1,
        max: 31,
      },
      endType: {
        type: String,
        enum: ["never", "onDate", "afterOccurrences"],
        default: "never",
      },
      endDate: {
        type: String,
        default: null,
      },
      maxOccurrences: {
        type: Number,
        default: null,
        min: 1,
      },
      timeZone: {
        type: String,
        default: "Asia/Ho_Chi_Minh",
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        if (!ret.dueDateType) {
          ret.dueDateType = ret.dueDate == null ? "none" : "dateTime";
        }
        if (ret.dueDateType === "none") {
          ret.dueDate = null;
          ret.dueDateDate = null;
          ret.timeZoneId = null;
        } else if (ret.dueDateType === "date") {
          ret.dueDate = null;
          ret.timeZoneId = null;
        } else {
          ret.dueDateDate = null;
          ret.timeZoneId ??= "Asia/Ho_Chi_Minh";
        }
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        if (!ret.dueDateType) {
          ret.dueDateType = ret.dueDate == null ? "none" : "dateTime";
        }
        if (ret.dueDateType === "none") {
          ret.dueDate = null;
          ret.dueDateDate = null;
          ret.timeZoneId = null;
        } else if (ret.dueDateType === "date") {
          ret.dueDate = null;
          ret.timeZoneId = null;
        } else {
          ret.dueDateDate = null;
          ret.timeZoneId ??= "Asia/Ho_Chi_Minh";
        }
        return ret;
      },
    },
  },
);

taskSchema.index(
  { recurrenceId: 1, occurrenceIndex: 1 },
  {
    unique: true,
    partialFilterExpression: { recurrenceId: { $type: "objectId" } },
  }
);

taskSchema.pre("validate", function (next) {
  if (this.reminderMinutesBefore != null && this.reminderMonthsBefore != null) {
    this.invalidate(
      "reminderMonthsBefore",
      "Chỉ được chọn một kiểu thời gian nhắc.",
    );
  }
  next();
});

const Task = mongoose.model("Task", taskSchema);

export default Task;
